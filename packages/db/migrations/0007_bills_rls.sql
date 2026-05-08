-- KPBooks 0007 -- RLS + lock-after-post triggers for bills and bill_lines.
--
-- Mirrors the invoice lock pattern in 0005: ENABLE+FORCE RLS, FOR ALL
-- company-scoped policy with WITH CHECK, plus updated_at toucher and a
-- lock-after-post trigger that allows only the void transition (and
-- payment-driven balance_due / status changes) to mutate a posted bill.
--
-- ASCII-only -- the WIN1252 embedded-postgres used in tests on Windows
-- chokes on em-dashes / box-drawing characters.

ALTER TABLE bills      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills      FORCE  ROW LEVEL SECURITY;
ALTER TABLE bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_lines FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bills_company_isolation ON bills;
CREATE POLICY bills_company_isolation ON bills
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP POLICY IF EXISTS bill_lines_company_isolation ON bill_lines;
CREATE POLICY bill_lines_company_isolation ON bill_lines
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS bills_updated_at_trg ON bills;
CREATE TRIGGER bills_updated_at_trg BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE FUNCTION bill_lock_after_post() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bill % cannot be deleted (void it instead)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'bill % is voided and immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id                       IS DISTINCT FROM OLD.id
     OR NEW.company_id            IS DISTINCT FROM OLD.company_id
     OR NEW.vendor_id             IS DISTINCT FROM OLD.vendor_id
     OR NEW.bill_number           IS DISTINCT FROM OLD.bill_number
     OR NEW.bill_date             IS DISTINCT FROM OLD.bill_date
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
      'bill % is locked; only status / balance_due / voided_* may change after posting',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS bills_lock_trg ON bills;
CREATE TRIGGER bills_lock_trg
  BEFORE UPDATE OR DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION bill_lock_after_post();

CREATE OR REPLACE FUNCTION bill_line_block_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'bill_line % is immutable; void the bill and recreate', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'bill_line % cannot be deleted', OLD.id
    USING ERRCODE = 'check_violation';
END
$$;

DROP TRIGGER IF EXISTS bill_lines_lock_trg ON bill_lines;
CREATE TRIGGER bill_lines_lock_trg
  BEFORE UPDATE OR DELETE ON bill_lines
  FOR EACH ROW EXECUTE FUNCTION bill_line_block_change();
