-- KPBooks 0011 -- RLS + updated_at + lock-after-post for bank_transactions.
-- ASCII-only to keep WIN1252 embedded-postgres happy.

ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bank_transactions_company_isolation ON bank_transactions;
CREATE POLICY bank_transactions_company_isolation ON bank_transactions
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS bank_transactions_updated_at_trg ON bank_transactions;
CREATE TRIGGER bank_transactions_updated_at_trg BEFORE UPDATE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Once a row is status='posted' it shouldn't be edited (the JE it created is
-- the canonical record). DELETE is rejected unconditionally so an
-- import-batch reimport can't quietly drop history.
CREATE OR REPLACE FUNCTION bank_transaction_lock_after_post() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank_transaction % cannot be deleted (mark ignored instead)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- TG_OP = 'UPDATE'.
  IF OLD.status = 'posted' THEN
    -- After posting, only updated_at may change. Identity + facts are frozen.
    IF NEW.id                       IS DISTINCT FROM OLD.id
       OR NEW.company_id            IS DISTINCT FROM OLD.company_id
       OR NEW.bank_account_id       IS DISTINCT FROM OLD.bank_account_id
       OR NEW.transaction_date      IS DISTINCT FROM OLD.transaction_date
       OR NEW.description           IS DISTINCT FROM OLD.description
       OR NEW.amount                IS DISTINCT FROM OLD.amount
       OR NEW.status                IS DISTINCT FROM OLD.status
       OR NEW.posted_journal_entry_id IS DISTINCT FROM OLD.posted_journal_entry_id
       OR NEW.import_batch_id       IS DISTINCT FROM OLD.import_batch_id
       OR NEW.created_at            IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'bank_transaction % is posted and immutable', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS bank_transactions_lock_trg ON bank_transactions;
CREATE TRIGGER bank_transactions_lock_trg
  BEFORE UPDATE OR DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION bank_transaction_lock_after_post();
