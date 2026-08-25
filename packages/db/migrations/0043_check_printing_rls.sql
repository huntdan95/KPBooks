-- KPBooks 0043 -- RLS for printed_checks.
--
-- Same shape as every other tenant table: row visibility is scoped to the
-- app.current_company GUC, and FORCE ROW LEVEL SECURITY so even the table
-- owner is subject to it. See 0029_app_user_role.sql for why the API must
-- also SET LOCAL ROLE kpbooks_app -- Neon's neondb_owner carries BYPASSRLS,
-- which trumps both the policy and FORCE.

ALTER TABLE printed_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE printed_checks FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

DO $$ BEGIN
  CREATE POLICY printed_checks_company_isolation ON printed_checks
    USING (company_id = current_setting('app.current_company', true)::uuid)
    WITH CHECK (company_id = current_setting('app.current_company', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON printed_checks TO kpbooks_app;

--> statement-breakpoint

-- A printed check is a financial record: the number, payee and amount are what
-- the bank will honour, so they must never be edited after the fact. Only the
-- void columns may change. Mirrors the locked-entry trigger on journal_entries.
CREATE OR REPLACE FUNCTION printed_checks_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.check_number     IS DISTINCT FROM OLD.check_number
     OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
     OR NEW.amount        IS DISTINCT FROM OLD.amount
     OR NEW.payee_name    IS DISTINCT FROM OLD.payee_name
     OR NEW.check_date    IS DISTINCT FROM OLD.check_date
     OR NEW.company_id    IS DISTINCT FROM OLD.company_id
  THEN
    RAISE EXCEPTION 'printed check % is immutable; void it and print a new one',
      OLD.check_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

DO $$ BEGIN
  CREATE TRIGGER printed_checks_immutable_trg
    BEFORE UPDATE ON printed_checks
    FOR EACH ROW EXECUTE FUNCTION printed_checks_immutable();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
