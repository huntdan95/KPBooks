-- KPBooks 0015 -- RLS + updated_at on tax_rates, plus invoice lock-trigger
-- update so the new tax_rate_id column joins the locked-after-post set.

ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rates FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tax_rates_company_isolation ON tax_rates;
CREATE POLICY tax_rates_company_isolation ON tax_rates
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS tax_rates_updated_at_trg ON tax_rates;
CREATE TRIGGER tax_rates_updated_at_trg BEFORE UPDATE ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The invoice lock-after-post trigger from migration 0005 didn't know about
-- tax_rate_id (column didn't exist). Re-create the function with tax_rate_id
-- in the locked column set so app-bug-grade attempts to flip it on a posted
-- invoice are caught at the DB layer.
CREATE OR REPLACE FUNCTION invoice_lock_after_post() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice % cannot be deleted (void it instead)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
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
     OR NEW.tax_rate_id           IS DISTINCT FROM OLD.tax_rate_id
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
