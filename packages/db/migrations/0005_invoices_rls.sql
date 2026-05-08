-- KPBooks 0005 -- RLS + lock-after-post triggers for invoices and invoice_lines.
--
-- Same defense-in-depth pattern as 0001/0003: ENABLE+FORCE RLS, FOR ALL
-- company-scoped policy with WITH CHECK, plus updated_at toucher on invoices.
--
-- Beyond RLS, invoices follow the same "post once, never edit" rule the
-- ledger already enforces on journal_entries: after insert, only the void
-- transition (and payment-driven balance_due / status changes) is allowed.
-- Any other column mutation is rejected at the DB layer so app-code bugs
-- can't quietly rewrite a posted A/R document. To "edit" an invoice you
-- void it and create a new one.
--
-- Idempotent so a re-run is safe.

ALTER TABLE invoices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices      FORCE  ROW LEVEL SECURITY;
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoices_company_isolation ON invoices;
CREATE POLICY invoices_company_isolation ON invoices
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP POLICY IF EXISTS invoice_lines_company_isolation ON invoice_lines;
CREATE POLICY invoice_lines_company_isolation ON invoice_lines
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS invoices_updated_at_trg ON invoices;
CREATE TRIGGER invoices_updated_at_trg BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Lock-after-post: only specific columns may change after creation.
-- Allowed to change post-insert:
--   status, balance_due, voided_at, voided_journal_entry_id, updated_at
-- Rejected: any other column change, and any DELETE.
CREATE OR REPLACE FUNCTION invoice_lock_after_post() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice % cannot be deleted (void it instead)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- TG_OP = 'UPDATE' below.
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'invoice % is voided and immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id                       IS DISTINCT FROM OLD.id
     OR NEW.company_id            IS DISTINCT FROM OLD.company_id
     OR NEW.customer_id           IS DISTINCT FROM OLD.customer_id
     OR NEW.invoice_number        IS DISTINCT FROM OLD.invoice_number
     OR NEW.invoice_date          IS DISTINCT FROM OLD.invoice_date
     OR NEW.due_date              IS DISTINCT FROM OLD.due_date
     OR NEW.terms_days            IS DISTINCT FROM OLD.terms_days
     OR NEW.memo                  IS DISTINCT FROM OLD.memo
     OR NEW.subtotal              IS DISTINCT FROM OLD.subtotal
     OR NEW.tax_amount            IS DISTINCT FROM OLD.tax_amount
     OR NEW.total                 IS DISTINCT FROM OLD.total
     OR NEW.posted_journal_entry_id IS DISTINCT FROM OLD.posted_journal_entry_id
     OR NEW.created_at            IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'invoice % is locked; only status / balance_due / voided_* may change after posting',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoices_lock_trg ON invoices;
CREATE TRIGGER invoices_lock_trg
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoice_lock_after_post();

-- invoice_lines are fully immutable after insert. Any explicit UPDATE/DELETE
-- is rejected. Cascade DELETE from invoice never fires because invoices
-- DELETE is itself rejected by the trigger above. Tests use
-- session_replication_role=replica to bypass for cleanup, same pattern as
-- journal_lines.
CREATE OR REPLACE FUNCTION invoice_line_block_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'invoice_line % is immutable; void the invoice and recreate', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'invoice_line % cannot be deleted', OLD.id
    USING ERRCODE = 'check_violation';
END
$$;

DROP TRIGGER IF EXISTS invoice_lines_lock_trg ON invoice_lines;
CREATE TRIGGER invoice_lines_lock_trg
  BEFORE UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_line_block_change();
