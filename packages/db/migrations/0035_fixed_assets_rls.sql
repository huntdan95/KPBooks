-- KPBooks 0035 -- RLS + updated_at trigger for fixed_assets.

ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fixed_assets_company_isolation ON fixed_assets;
CREATE POLICY fixed_assets_company_isolation ON fixed_assets
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS fixed_assets_updated_at_trg ON fixed_assets;
CREATE TRIGGER fixed_assets_updated_at_trg BEFORE UPDATE ON fixed_assets
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
