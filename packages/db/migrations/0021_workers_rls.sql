-- KPBooks 0021 -- RLS for worker_documents.
-- (vendors RLS was already established in migration 0003.)

ALTER TABLE worker_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_documents FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS worker_documents_company_isolation ON worker_documents;
CREATE POLICY worker_documents_company_isolation ON worker_documents
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
