-- KPBooks 0039 -- RLS + lock-after-post trigger for mileage_trips.

ALTER TABLE mileage_trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE mileage_trips FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mileage_trips_company_isolation ON mileage_trips;
CREATE POLICY mileage_trips_company_isolation ON mileage_trips
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

DROP TRIGGER IF EXISTS mileage_trips_updated_at_trg ON mileage_trips;
CREATE TRIGGER mileage_trips_updated_at_trg BEFORE UPDATE ON mileage_trips
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Lock-after-post: once status='posted', block edits to all fields except
-- status (which the void path can flip back to 'logged') and the link
-- columns (posted_journal_entry_id + posted_at). Trip data is part of the
-- audit trail of the posted JE; mutating it would orphan the JE summary.
CREATE OR REPLACE FUNCTION mileage_trip_lock_after_post() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    IF NEW.id                      IS DISTINCT FROM OLD.id
       OR NEW.company_id           IS DISTINCT FROM OLD.company_id
       OR NEW.trip_date            IS DISTINCT FROM OLD.trip_date
       OR NEW.start_location       IS DISTINCT FROM OLD.start_location
       OR NEW.end_location         IS DISTINCT FROM OLD.end_location
       OR NEW.vehicle              IS DISTINCT FROM OLD.vehicle
       OR NEW.start_odometer       IS DISTINCT FROM OLD.start_odometer
       OR NEW.end_odometer         IS DISTINCT FROM OLD.end_odometer
       OR NEW.miles                IS DISTINCT FROM OLD.miles
       OR NEW.purpose              IS DISTINCT FROM OLD.purpose
       OR NEW.notes                IS DISTINCT FROM OLD.notes
       OR NEW.rate_per_mile        IS DISTINCT FROM OLD.rate_per_mile
       OR NEW.deduction            IS DISTINCT FROM OLD.deduction
    THEN
      RAISE EXCEPTION 'mileage trip is posted -- cannot edit trip data'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND OLD.status = 'posted' THEN
    RAISE EXCEPTION 'mileage trip is posted -- cannot delete (use void instead)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS mileage_trips_lock_trg ON mileage_trips;
CREATE TRIGGER mileage_trips_lock_trg
  BEFORE UPDATE OR DELETE ON mileage_trips
  FOR EACH ROW EXECUTE FUNCTION mileage_trip_lock_after_post();
