-- KPBooks 0009 -- RLS + lock-after-post triggers for payments and payment_applications.
--
-- ASCII-only to keep WIN1252 embedded-postgres happy on Windows test runs.

ALTER TABLE payments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments              FORCE  ROW LEVEL SECURITY;
ALTER TABLE payment_applications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_applications  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payments_company_isolation ON payments;
CREATE POLICY payments_company_isolation ON payments
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP POLICY IF EXISTS payment_applications_company_isolation ON payment_applications;
CREATE POLICY payment_applications_company_isolation ON payment_applications
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS payments_updated_at_trg ON payments;
CREATE TRIGGER payments_updated_at_trg BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Payments are locked after insert. The void transition writes
-- voided_at + voided_journal_entry_id and flips status to 'void'; nothing
-- else may mutate. DELETE is always rejected.
CREATE OR REPLACE FUNCTION payment_lock_after_post() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment % cannot be deleted (void it instead)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'payment % is voided and immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id                       IS DISTINCT FROM OLD.id
     OR NEW.company_id            IS DISTINCT FROM OLD.company_id
     OR NEW.payment_type          IS DISTINCT FROM OLD.payment_type
     OR NEW.customer_id           IS DISTINCT FROM OLD.customer_id
     OR NEW.vendor_id             IS DISTINCT FROM OLD.vendor_id
     OR NEW.payment_date          IS DISTINCT FROM OLD.payment_date
     OR NEW.payment_method        IS DISTINCT FROM OLD.payment_method
     OR NEW.reference             IS DISTINCT FROM OLD.reference
     OR NEW.bank_account_id       IS DISTINCT FROM OLD.bank_account_id
     OR NEW.amount                IS DISTINCT FROM OLD.amount
     OR NEW.memo                  IS DISTINCT FROM OLD.memo
     OR NEW.posted_journal_entry_id IS DISTINCT FROM OLD.posted_journal_entry_id
     OR NEW.created_at            IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'payment % is locked; only status / voided_* may change after posting',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payments_lock_trg ON payments;
CREATE TRIGGER payments_lock_trg
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payment_lock_after_post();

-- payment_applications are fully immutable after insert. Mutation is rejected;
-- cleanup uses session_replication_role=replica (admin path) like other locked
-- tables.
CREATE OR REPLACE FUNCTION payment_application_block_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'payment_application % is immutable; void the payment and recreate', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'payment_application % cannot be deleted', OLD.id
    USING ERRCODE = 'check_violation';
END
$$;

DROP TRIGGER IF EXISTS payment_applications_lock_trg ON payment_applications;
CREATE TRIGGER payment_applications_lock_trg
  BEFORE UPDATE OR DELETE ON payment_applications
  FOR EACH ROW EXECUTE FUNCTION payment_application_block_change();
