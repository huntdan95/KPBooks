-- KPBooks 0037 -- RLS + append-only trigger for activity_log.

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS activity_log_company_isolation ON activity_log;
CREATE POLICY activity_log_company_isolation ON activity_log
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

-- Append-only enforcement. Once a row is inserted, no UPDATE or DELETE is
-- allowed -- mutating the audit trail would defeat its purpose. INSERT is
-- still permitted (and in fact is the only allowed write operation). If a
-- bug ever inserts a wrong row, the right move is to insert a corrective
-- row (action='audit_correction') referencing the bad one, not to mutate.
CREATE OR REPLACE FUNCTION activity_log_block_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity_log is append-only; cannot % rows', TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

DROP TRIGGER IF EXISTS activity_log_no_update_trg ON activity_log;
CREATE TRIGGER activity_log_no_update_trg
  BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_block_mutation();
