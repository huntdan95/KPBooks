-- KPBooks 0003 — RLS + updated_at triggers for customers and vendors.
--
-- Adds the same defense-in-depth pattern used for accounts and journal_*:
-- ENABLE + FORCE row-level security, FOR ALL policy keyed on
-- app_current_company(), and a touch_updated_at() BEFORE UPDATE trigger.
--
-- Idempotent so a re-run is safe.

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE  ROW LEVEL SECURITY;
ALTER TABLE vendors   ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors   FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customers_company_isolation ON customers;
CREATE POLICY customers_company_isolation ON customers
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP POLICY IF EXISTS vendors_company_isolation ON vendors;
CREATE POLICY vendors_company_isolation ON vendors
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS customers_updated_at_trg ON customers;
CREATE TRIGGER customers_updated_at_trg BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS vendors_updated_at_trg ON vendors;
CREATE TRIGGER vendors_updated_at_trg BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
