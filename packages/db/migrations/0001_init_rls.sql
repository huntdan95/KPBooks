-- KPBooks 0001 — RLS, current-company GUC, deferred ledger balance trigger.
--
-- Run this after Drizzle's generated table-creation migration. This file is the
-- accounting spine: row-level security on every domain table + the deferred
-- per-entry balance constraint that makes double-entry honest.
--
-- Idempotent so you can re-run on dev DBs.

-- ----------------------------------------------------------------------------
-- 1. Application role configured by the app on every request transaction.
--    The Cloud Run API plugin runs:
--        SET LOCAL app.current_company = '<uuid>';
--        SET LOCAL app.current_user    = '<uuid>';
--        SET LOCAL app.current_role    = 'bookkeeper' | 'admin' | ...
--    Without these, the RLS policies below reject all reads and writes.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_current_company() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_company', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_role() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_role', true), '')
$$;

CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT app_current_role() IN ('owner', 'admin')
$$;

-- ----------------------------------------------------------------------------
-- 2. RLS policies. Default-deny by enabling RLS, then permit company-scoped rows.
--    `users` and `memberships` are loaded by the auth plugin BEFORE the GUC is
--    set, so we use a "service" bypass via the role rather than RLS for those.
-- ----------------------------------------------------------------------------

-- ENABLE plus FORCE: even table owners and superusers see RLS policies fire.
-- Without FORCE, a superuser connection (or the table owner) bypasses RLS
-- entirely. FORCE is the correct default for a defense-in-depth model.
ALTER TABLE companies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies          FORCE  ROW LEVEL SECURITY;
ALTER TABLE accounts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts           FORCE  ROW LEVEL SECURITY;
ALTER TABLE journal_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries    FORCE  ROW LEVEL SECURITY;
ALTER TABLE journal_lines      ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines      FORCE  ROW LEVEL SECURITY;

-- companies: a user sees only the companies they're a member of.
DROP POLICY IF EXISTS companies_member_access ON companies;
CREATE POLICY companies_member_access ON companies
  FOR ALL
  USING (
    id = app_current_company()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.company_id = companies.id AND m.user_id = app_current_user()
    )
  )
  WITH CHECK (id = app_current_company());

-- All other domain tables: scoped strictly to current_company.
DROP POLICY IF EXISTS accounts_company_isolation ON accounts;
CREATE POLICY accounts_company_isolation ON accounts
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP POLICY IF EXISTS journal_entries_company_isolation ON journal_entries;
CREATE POLICY journal_entries_company_isolation ON journal_entries
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP POLICY IF EXISTS journal_lines_company_isolation ON journal_lines;
CREATE POLICY journal_lines_company_isolation ON journal_lines
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

-- ----------------------------------------------------------------------------
-- 3. Closed-period guard. Inserts/updates with entry_date <= closed_through_date
--    are blocked unless app_is_admin() and an override flag is set on the txn.
--    The override is a per-transaction GUC so an admin must explicitly opt in.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ledger_enforce_closed_period() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  closed date;
  override boolean;
BEGIN
  SELECT closed_through_date INTO closed FROM companies WHERE id = NEW.company_id;
  IF closed IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.entry_date > closed THEN
    RETURN NEW;
  END IF;

  override := COALESCE(NULLIF(current_setting('app.allow_closed_period', true), ''), 'false')::boolean;
  IF override AND app_is_admin() THEN
    -- Caller is responsible for writing an audit_log entry; we don't fabricate one here.
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'cannot post to closed period (entry_date=% closed_through=%)', NEW.entry_date, closed
    USING ERRCODE = 'check_violation';
END
$$;

DROP TRIGGER IF EXISTS journal_entries_closed_period_trg ON journal_entries;
CREATE TRIGGER journal_entries_closed_period_trg
  BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_enforce_closed_period();

-- ----------------------------------------------------------------------------
-- 4. Deferred balance constraint. Per (entry_id, currency), debits must equal
--    credits. DEFERRABLE INITIALLY DEFERRED so the trigger fires at COMMIT
--    rather than mid-statement — this lets posting.service insert the entry
--    and its lines in the same transaction without ordering acrobatics.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  bad RECORD;
BEGIN
  FOR bad IN
    SELECT
      l.entry_id,
      l.currency,
      SUM(l.debit)  AS total_debit,
      SUM(l.credit) AS total_credit
    FROM journal_lines l
    WHERE l.entry_id = COALESCE(NEW.entry_id, OLD.entry_id)
    GROUP BY l.entry_id, l.currency
    HAVING SUM(l.debit) <> SUM(l.credit)
  LOOP
    RAISE EXCEPTION
      'journal_entry % is unbalanced in %: debits=% credits=%',
      bad.entry_id, bad.currency, bad.total_debit, bad.total_credit
      USING ERRCODE = 'check_violation';
  END LOOP;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS journal_lines_balanced_trg ON journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_balanced_trg
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

-- Also assert each entry has at least 2 lines at COMMIT (single-leg posts are bugs).
CREATE OR REPLACE FUNCTION ledger_assert_min_two_lines() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  cnt int;
BEGIN
  SELECT COUNT(*) INTO cnt FROM journal_lines WHERE entry_id = NEW.id;
  IF cnt < 2 THEN
    RAISE EXCEPTION 'journal_entry % must have >= 2 lines, has %', NEW.id, cnt
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS journal_entries_min_lines_trg ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_min_lines_trg
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_min_two_lines();

-- ----------------------------------------------------------------------------
-- 5. Locked entries are immutable. Editing a posted entry produces a reversal.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ledger_block_locked_entry_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- An already-locked entry is immutable. The first transition (false -> true)
  -- is allowed because OLD.locked is still false at that point.
  IF TG_OP = 'UPDATE' AND OLD.locked THEN
    RAISE EXCEPTION 'journal_entry % is locked', OLD.id
      USING ERRCODE = 'check_violation';
  ELSIF TG_OP = 'DELETE' AND OLD.locked THEN
    RAISE EXCEPTION 'journal_entry % is locked, cannot delete', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS journal_entries_lock_trg ON journal_entries;
CREATE TRIGGER journal_entries_lock_trg
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_block_locked_entry_change();

CREATE OR REPLACE FUNCTION ledger_block_locked_line_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  parent_locked boolean;
BEGIN
  SELECT locked INTO parent_locked FROM journal_entries
    WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
  IF parent_locked THEN
    RAISE EXCEPTION 'journal_entry % is locked, lines are immutable',
      COALESCE(NEW.entry_id, OLD.entry_id)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS journal_lines_lock_trg ON journal_lines;
CREATE TRIGGER journal_lines_lock_trg
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_block_locked_line_change();

-- ----------------------------------------------------------------------------
-- 6. updated_at touchers (avoid ORM forgetting).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS companies_updated_at_trg ON companies;
CREATE TRIGGER companies_updated_at_trg BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS users_updated_at_trg ON users;
CREATE TRIGGER users_updated_at_trg BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS accounts_updated_at_trg ON accounts;
CREATE TRIGGER accounts_updated_at_trg BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
