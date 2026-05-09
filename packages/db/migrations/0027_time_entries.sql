-- KPBooks 0027 -- Billable time entries.
--
-- A bookkeeper logs hours per contractor throughout the month; "Build bill"
-- collects the unbilled entries for one vendor and posts a real A/P bill via
-- the existing bills.posting service (one bill_line per entry). Entries flip
-- to billed_bill_id + billed_at on success and become immutable from there.
-- This replaces the spreadsheet workflow most CPAs run on the side.

CREATE TABLE IF NOT EXISTS "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"hours" numeric(10, 4) NOT NULL,
	"rate" numeric(19, 4) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"description" text NOT NULL,
	"project" text,
	"account_id" uuid NOT NULL,
	"billed_bill_id" uuid,
	"billed_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entries_hours_positive" CHECK ("time_entries"."hours" > 0),
	CONSTRAINT "time_entries_rate_non_negative" CHECK ("time_entries"."rate" >= 0),
	CONSTRAINT "time_entries_amount_non_negative" CHECK ("time_entries"."amount" >= 0),
	CONSTRAINT "time_entries_billed_consistency" CHECK (("time_entries"."billed_bill_id" IS NULL) = ("time_entries"."billed_at" IS NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_billed_bill_id_bills_id_fk" FOREIGN KEY ("billed_bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_entries_company_vendor_idx" ON "time_entries" USING btree ("company_id","vendor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_entries_company_date_idx" ON "time_entries" USING btree ("company_id","entry_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_entries_billed_bill_idx" ON "time_entries" USING btree ("billed_bill_id");
--> statement-breakpoint
-- Partial index of unbilled entries per vendor -- the buildBill query uses this
-- as the hot path. ~5x faster than scanning when most entries are billed.
CREATE INDEX IF NOT EXISTS "time_entries_unbilled_idx" ON "time_entries" USING btree ("company_id","vendor_id","entry_date") WHERE "billed_bill_id" IS NULL;
