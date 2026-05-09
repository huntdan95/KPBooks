-- KPBooks 0031 -- RLS + updated_at trigger on items.

ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS items_company_isolation ON items;
CREATE POLICY items_company_isolation ON items
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS items_updated_at_trg ON items;
CREATE TRIGGER items_updated_at_trg BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
