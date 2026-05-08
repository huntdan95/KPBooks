-- KPBooks 0017 -- RLS + updated_at on bank_rules.

ALTER TABLE bank_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_rules FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bank_rules_company_isolation ON bank_rules;
CREATE POLICY bank_rules_company_isolation ON bank_rules
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS bank_rules_updated_at_trg ON bank_rules;
CREATE TRIGGER bank_rules_updated_at_trg BEFORE UPDATE ON bank_rules
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
