-- KPBooks 0019 -- RLS, updated_at trigger, and lock-after-convert trigger on estimates.
-- Estimates are mutable until status flips to 'converted'; once converted, the
-- row + its lines become immutable so the audit trail from quote -> invoice
-- stays intact.

ALTER TABLE estimates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimates       FORCE  ROW LEVEL SECURITY;
ALTER TABLE estimate_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimate_lines  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS estimates_company_isolation ON estimates;
CREATE POLICY estimates_company_isolation ON estimates
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP POLICY IF EXISTS estimate_lines_company_isolation ON estimate_lines;
CREATE POLICY estimate_lines_company_isolation ON estimate_lines
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS estimates_updated_at_trg ON estimates;
CREATE TRIGGER estimates_updated_at_trg BEFORE UPDATE ON estimates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Lock-after-convert: once the estimate is converted, only the conversion-related
-- columns may have flipped. Any subsequent UPDATE that would alter business data
-- on a converted estimate is rejected. DELETE on a converted estimate is also
-- blocked so the audit trail survives.
CREATE OR REPLACE FUNCTION estimate_lock_after_convert() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'converted' THEN
      RAISE EXCEPTION 'estimate % is converted and immutable', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'converted' THEN
    IF NEW.id                     IS DISTINCT FROM OLD.id
       OR NEW.company_id          IS DISTINCT FROM OLD.company_id
       OR NEW.customer_id         IS DISTINCT FROM OLD.customer_id
       OR NEW.estimate_number     IS DISTINCT FROM OLD.estimate_number
       OR NEW.estimate_date       IS DISTINCT FROM OLD.estimate_date
       OR NEW.expiration_date     IS DISTINCT FROM OLD.expiration_date
       OR NEW.terms_days          IS DISTINCT FROM OLD.terms_days
       OR NEW.memo                IS DISTINCT FROM OLD.memo
       OR NEW.subtotal            IS DISTINCT FROM OLD.subtotal
       OR NEW.tax_rate_id         IS DISTINCT FROM OLD.tax_rate_id
       OR NEW.tax_amount          IS DISTINCT FROM OLD.tax_amount
       OR NEW.total               IS DISTINCT FROM OLD.total
       OR NEW.converted_invoice_id IS DISTINCT FROM OLD.converted_invoice_id
       OR NEW.converted_at        IS DISTINCT FROM OLD.converted_at
       OR NEW.created_at          IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'estimate % is converted and locked', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS estimates_lock_after_convert_trg ON estimates;
CREATE TRIGGER estimates_lock_after_convert_trg
  BEFORE UPDATE OR DELETE ON estimates
  FOR EACH ROW EXECUTE FUNCTION estimate_lock_after_convert();

-- Lines on a converted estimate are also immutable.
CREATE OR REPLACE FUNCTION estimate_line_lock_after_convert() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  parent_status estimate_status;
BEGIN
  SELECT status INTO parent_status FROM estimates WHERE id = COALESCE(NEW.estimate_id, OLD.estimate_id);
  IF parent_status = 'converted' THEN
    RAISE EXCEPTION 'estimate is converted; lines are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS estimate_lines_lock_after_convert_trg ON estimate_lines;
CREATE TRIGGER estimate_lines_lock_after_convert_trg
  BEFORE INSERT OR UPDATE OR DELETE ON estimate_lines
  FOR EACH ROW EXECUTE FUNCTION estimate_line_lock_after_convert();
