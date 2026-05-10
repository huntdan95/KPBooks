-- KPBooks 0038 -- Slice #43: mileage tracking.
--
-- Trip-level log with per-trip rate-locking: the IRS standard mileage rate
-- changes mid-year sometimes (it has happened in 2008, 2011, 2022). If the
-- rate changes, we don't want previously-logged trips to silently re-compute
-- their deduction. So each trip stores the rate it was logged at, and the
-- deduction column is the snapshot product (miles × rate).
--
-- companies.mileage_rate_default: the current rate the new-trip form prefills.
-- Bookkeeper can change at company level when the IRS publishes a new rate.
-- Default 0.670000 = the 2024 IRS standard mileage rate.
--
-- mileage_trips: one row per trip. Trip is editable until status='posted', at
-- which point the lock-after-post trigger (in 0039) blocks structural edits.
-- Posting is batched: bookkeeper picks a date range + expense and credit
-- accounts; the service writes ONE journal entry summing all logged trips
-- in range, marks each row 'posted', and stamps posted_journal_entry_id.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS mileage_rate_default numeric(19, 6) DEFAULT 0.670000 NOT NULL;

--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE mileage_trip_status AS ENUM ('logged', 'posted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mileage_trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"trip_date" date NOT NULL,
	"start_location" text,
	"end_location" text,
	"vehicle" text,
	"start_odometer" numeric(10, 1),
	"end_odometer" numeric(10, 1),
	"miles" numeric(10, 2) NOT NULL,
	"purpose" text NOT NULL,
	"notes" text,
	"rate_per_mile" numeric(19, 6) NOT NULL,
	"deduction" numeric(19, 4) NOT NULL,
	"status" "mileage_trip_status" DEFAULT 'logged' NOT NULL,
	"posted_journal_entry_id" uuid,
	"posted_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mileage_trips_miles_positive" CHECK ("miles" > 0),
	CONSTRAINT "mileage_trips_rate_positive" CHECK ("rate_per_mile" > 0),
	CONSTRAINT "mileage_trips_deduction_non_negative" CHECK ("deduction" >= 0),
	CONSTRAINT "mileage_trips_purpose_nonempty" CHECK (length("purpose") > 0),
	CONSTRAINT "mileage_trips_odometer_order" CHECK (
	  "start_odometer" IS NULL OR "end_odometer" IS NULL OR "end_odometer" >= "start_odometer"
	),
	CONSTRAINT "mileage_trips_posted_consistency" CHECK (
	  ("status" = 'posted') = ("posted_journal_entry_id" IS NOT NULL)
	  AND ("status" = 'posted') = ("posted_at" IS NOT NULL)
	)
);

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "mileage_trips" ADD CONSTRAINT "mileage_trips_company_id_companies_id_fk"
   FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "mileage_trips" ADD CONSTRAINT "mileage_trips_posted_journal_entry_id_journal_entries_id_fk"
   FOREIGN KEY ("posted_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "mileage_trips" ADD CONSTRAINT "mileage_trips_created_by_user_id_users_id_fk"
   FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mileage_trips_company_status_date_idx"
  ON "mileage_trips" USING btree ("company_id", "status", "trip_date" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mileage_trips_company_date_idx"
  ON "mileage_trips" USING btree ("company_id", "trip_date" DESC);
