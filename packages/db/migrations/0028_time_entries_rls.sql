-- KPBooks 0028 -- RLS, updated_at, and lock-after-billed for time_entries.
--
-- Once a time entry is attached to a bill (billed_bill_id IS NOT NULL) it
-- becomes immutable except for the un-bill case (bill voided -> bill clears
-- billed_bill_id back to NULL, allowing the entry to be re-billed).

ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS time_entries_company_isolation ON time_entries;
CREATE POLICY time_entries_company_isolation ON time_entries
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS time_entries_updated_at_trg ON time_entries;
CREATE TRIGGER time_entries_updated_at_trg BEFORE UPDATE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE FUNCTION time_entry_lock_after_billed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.billed_bill_id IS NOT NULL THEN
      RAISE EXCEPTION 'time entry % is locked (billed on bill %)', OLD.id, OLD.billed_bill_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.billed_bill_id IS NOT NULL THEN
    -- Allow only the unbill transition (bill voided): NEW.billed_bill_id IS NULL.
    -- Block any other change while billed_bill_id is non-NULL.
    IF NEW.billed_bill_id IS NOT NULL THEN
      IF NEW.id            IS DISTINCT FROM OLD.id
         OR NEW.company_id IS DISTINCT FROM OLD.company_id
         OR NEW.vendor_id  IS DISTINCT FROM OLD.vendor_id
         OR NEW.entry_date IS DISTINCT FROM OLD.entry_date
         OR NEW.hours      IS DISTINCT FROM OLD.hours
         OR NEW.rate       IS DISTINCT FROM OLD.rate
         OR NEW.amount     IS DISTINCT FROM OLD.amount
         OR NEW.description IS DISTINCT FROM OLD.description
         OR NEW.account_id IS DISTINCT FROM OLD.account_id
      THEN
        RAISE EXCEPTION 'time entry % is locked (billed on bill %)', OLD.id, OLD.billed_bill_id
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS time_entries_lock_after_billed_trg ON time_entries;
CREATE TRIGGER time_entries_lock_after_billed_trg
  BEFORE UPDATE OR DELETE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION time_entry_lock_after_billed();
