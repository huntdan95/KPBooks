-- KPBooks 0023 -- RLS + updated_at trigger on recurring_templates.

ALTER TABLE recurring_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_templates FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recurring_templates_company_isolation ON recurring_templates;
CREATE POLICY recurring_templates_company_isolation ON recurring_templates
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS recurring_templates_updated_at_trg ON recurring_templates;
CREATE TRIGGER recurring_templates_updated_at_trg BEFORE UPDATE ON recurring_templates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
