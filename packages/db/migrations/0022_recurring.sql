-- KPBooks 0022 -- Recurring invoice/bill templates.
--
-- Stores a payload + schedule. When a template "fires" we resolve the payload
-- through the existing invoice/bill posting service (so all of the same
-- validation + ledger writes happen) and bump next_run_date by frequency.
-- Manual fire today; cron-driven fire is a v2 concern.

DO $$ BEGIN
 CREATE TYPE "public"."recurring_template_kind" AS ENUM('invoice', 'bill');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."recurring_frequency" AS ENUM('weekly', 'biweekly', 'monthly', 'quarterly', 'annually');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurring_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "recurring_template_kind" NOT NULL,
	"name" text NOT NULL,
	"frequency" "recurring_frequency" NOT NULL,
	-- For monthly+ schedules: 1-31. day=31 means "last day of month" so
	-- February gets 28/29, April gets 30, etc.
	"day_of_month" smallint,
	-- For weekly/biweekly: 0=Sun .. 6=Sat
	"day_of_week" smallint,
	"start_date" date NOT NULL,
	"end_date" date,
	"next_run_date" date NOT NULL,
	"last_run_date" date,
	"last_run_document_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	-- Snapshot of the template body. Resolved through invoices/bills posting
	-- service when the template fires:
	--   { customerId? | vendorId?, termsDays?, memo?, taxRateId?,
	--     lines: [{ accountId, description, quantity, unitPrice, taxable }],
	--     numberPrefix? }
	"payload" jsonb NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_templates_dom_range" CHECK ("recurring_templates"."day_of_month" IS NULL OR ("recurring_templates"."day_of_month" >= 1 AND "recurring_templates"."day_of_month" <= 31)),
	CONSTRAINT "recurring_templates_dow_range" CHECK ("recurring_templates"."day_of_week" IS NULL OR ("recurring_templates"."day_of_week" >= 0 AND "recurring_templates"."day_of_week" <= 6))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recurring_templates_company_active_idx" ON "recurring_templates" USING btree ("company_id","is_active","next_run_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recurring_templates_company_kind_idx" ON "recurring_templates" USING btree ("company_id","kind");
