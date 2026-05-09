-- KPBooks 0033 -- RLS + lock-after-post triggers for payroll_runs.

ALTER TABLE payroll_runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs       FORCE  ROW LEVEL SECURITY;
ALTER TABLE payroll_run_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_run_lines  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_runs_company_isolation ON payroll_runs;
CREATE POLICY payroll_runs_company_isolation ON payroll_runs
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP POLICY IF EXISTS payroll_run_lines_company_isolation ON payroll_run_lines;
CREATE POLICY payroll_run_lines_company_isolation ON payroll_run_lines
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS payroll_runs_updated_at_trg ON payroll_runs;
CREATE TRIGGER payroll_runs_updated_at_trg BEFORE UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Lock-after-post: once parent run is 'posted', lines are immutable until
-- the run is voided. Run-level void path clears posted_payment_id (via
-- FK ON DELETE set null when payments are voided) and flips status, so
-- subsequent edits are still rejected -- voided runs are also frozen.
CREATE OR REPLACE FUNCTION payroll_run_line_lock_after_post() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  parent_status payroll_run_status;
BEGIN
  SELECT status INTO parent_status
    FROM payroll_runs
   WHERE id = COALESCE(NEW.payroll_run_id, OLD.payroll_run_id);
  IF parent_status IN ('posted', 'voided') THEN
    -- Allow internal updates that ONLY touch posted_payment_id (so the
    -- service can stamp it during the post transaction) -- but block
    -- structural edits.
    IF TG_OP = 'UPDATE' THEN
      IF NEW.id                      IS DISTINCT FROM OLD.id
         OR NEW.payroll_run_id       IS DISTINCT FROM OLD.payroll_run_id
         OR NEW.company_id           IS DISTINCT FROM OLD.company_id
         OR NEW.vendor_id            IS DISTINCT FROM OLD.vendor_id
         OR NEW.worker_type_at_creation IS DISTINCT FROM OLD.worker_type_at_creation
         OR NEW.hours                IS DISTINCT FROM OLD.hours
         OR NEW.rate                 IS DISTINCT FROM OLD.rate
         OR NEW.gross                IS DISTINCT FROM OLD.gross
         OR NEW.federal_income_tax   IS DISTINCT FROM OLD.federal_income_tax
         OR NEW.social_security      IS DISTINCT FROM OLD.social_security
         OR NEW.medicare             IS DISTINCT FROM OLD.medicare
         OR NEW.state_income_tax     IS DISTINCT FROM OLD.state_income_tax
         OR NEW.other_deductions     IS DISTINCT FROM OLD.other_deductions
         OR NEW.net                  IS DISTINCT FROM OLD.net
         OR NEW.memo                 IS DISTINCT FROM OLD.memo
         OR NEW.created_at           IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'payroll run is % -- lines are locked', parent_status
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    -- INSERT / DELETE always blocked
    RAISE EXCEPTION 'payroll run is % -- cannot add or remove lines', parent_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS payroll_run_lines_lock_trg ON payroll_run_lines;
CREATE TRIGGER payroll_run_lines_lock_trg
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_run_lines
  FOR EACH ROW EXECUTE FUNCTION payroll_run_line_lock_after_post();
