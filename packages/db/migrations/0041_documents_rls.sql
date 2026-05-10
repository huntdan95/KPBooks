-- KPBooks 0041 -- RLS + updated_at trigger for documents.

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS documents_company_isolation ON documents;
CREATE POLICY documents_company_isolation ON documents
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS documents_updated_at_trg ON documents;
CREATE TRIGGER documents_updated_at_trg BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
