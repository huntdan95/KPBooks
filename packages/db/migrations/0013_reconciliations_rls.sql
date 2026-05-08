-- KPBooks 0013 -- RLS + updated_at + lock-after-complete for reconciliations.
-- ASCII-only.

ALTER TABLE reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliations FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reconciliations_company_isolation ON reconciliations;
CREATE POLICY reconciliations_company_isolation ON reconciliations
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS reconciliations_updated_at_trg ON reconciliations;
CREATE TRIGGER reconciliations_updated_at_trg BEFORE UPDATE ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Once status='completed', the reconciliation snapshot is immutable.
-- Reopening (going back to in_progress) is only allowed via a dedicated
-- service action that the API guards by role; the trigger blocks raw
-- non-allowed mutations.
CREATE OR REPLACE FUNCTION reconciliation_lock_after_complete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reconciliation % cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'completed' AND NEW.status = 'completed' THEN
    -- Allowed to update notes only.
    IF NEW.id                  IS DISTINCT FROM OLD.id
       OR NEW.company_id       IS DISTINCT FROM OLD.company_id
       OR NEW.bank_account_id  IS DISTINCT FROM OLD.bank_account_id
       OR NEW.statement_date   IS DISTINCT FROM OLD.statement_date
       OR NEW.statement_balance IS DISTINCT FROM OLD.statement_balance
       OR NEW.beginning_balance IS DISTINCT FROM OLD.beginning_balance
       OR NEW.completed_at     IS DISTINCT FROM OLD.completed_at
       OR NEW.completed_by     IS DISTINCT FROM OLD.completed_by
       OR NEW.created_at       IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'reconciliation % is completed; only notes may change', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS reconciliations_lock_trg ON reconciliations;
CREATE TRIGGER reconciliations_lock_trg
  BEFORE UPDATE OR DELETE ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION reconciliation_lock_after_complete();
