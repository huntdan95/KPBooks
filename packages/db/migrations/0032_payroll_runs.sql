-- KPBooks 0032 -- Phase C of payroll-tracking module: pay-run batch entry.
--
-- A payroll_run is a batch of paychecks for one pay period. Status flow:
--   draft   -> bookkeeper is editing lines
--   posted  -> each line wrote ONE payment (vendor_sent) at NET via
--              existing posting service; lines + run lock down
--   voided  -> the linked payments were voided; run is preserved for audit
--
-- Per-line gross / federal / FICA / Medicare / state / other deductions /
-- net are stored for display on pay stubs (slice #30 already prints them);
-- KPBooks does NOT compute taxes. Net is what hits the bank account.
--
-- snapshot_worker_type: stored at line-creation so that a later
-- reclassification (e.g. user flips a contractor to subcontractor)
-- doesn't rewrite history on the payroll register.

DO $$ BEGIN
  CREATE TYPE payroll_run_status AS ENUM ('draft', 'posted', 'voided');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pay_date" date NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_schedule" "pay_schedule",
	"worker_type_filter" "worker_type",
	-- Which bank/CC account checks are drawn from. Required at post time;
	-- nullable so drafts can be saved without committing to one yet.
	"bank_account_id" uuid,
	"status" "payroll_run_status" DEFAULT 'draft' NOT NULL,
	"memo" text,
	"total_gross" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total_net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"posted_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_period_order"  CHECK ("payroll_runs"."period_end" >= "payroll_runs"."period_start"),
	CONSTRAINT "payroll_runs_pay_after_start" CHECK ("payroll_runs"."pay_date" >= "payroll_runs"."period_start"),
	CONSTRAINT "payroll_runs_amounts_non_negative" CHECK ("payroll_runs"."total_gross" >= 0 AND "payroll_runs"."total_net" >= 0),
	CONSTRAINT "payroll_runs_posted_consistency" CHECK (("payroll_runs"."status" = 'posted') = ("payroll_runs"."posted_at" IS NOT NULL)),
	CONSTRAINT "payroll_runs_voided_consistency" CHECK (("payroll_runs"."status" = 'voided') = ("payroll_runs"."voided_at" IS NOT NULL))
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payroll_run_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	-- Snapshot of vendor.worker_type at line-creation; reclassification
	-- later doesn't rewrite the historical run.
	"worker_type_at_creation" "worker_type",
	"hours" numeric(10, 4),
	"rate" numeric(19, 4),
	"gross" numeric(19, 4) NOT NULL,
	"federal_income_tax" numeric(19, 4) DEFAULT '0' NOT NULL,
	"social_security" numeric(19, 4) DEFAULT '0' NOT NULL,
	"medicare" numeric(19, 4) DEFAULT '0' NOT NULL,
	"state_income_tax" numeric(19, 4) DEFAULT '0' NOT NULL,
	"other_deductions" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"memo" text,
	-- Set when the parent run posts; FK to the payment row this line wrote.
	"posted_payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_run_lines_amounts_non_negative" CHECK (
	  "payroll_run_lines"."gross" >= 0
	  AND "payroll_run_lines"."federal_income_tax" >= 0
	  AND "payroll_run_lines"."social_security" >= 0
	  AND "payroll_run_lines"."medicare" >= 0
	  AND "payroll_run_lines"."state_income_tax" >= 0
	  AND "payroll_run_lines"."other_deductions" >= 0
	  AND "payroll_run_lines"."net" >= 0
	)
);

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_company_id_companies_id_fk"
   FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_user_id_users_id_fk"
   FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_bank_account_id_accounts_id_fk"
   FOREIGN KEY ("bank_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_payroll_run_id_payroll_runs_id_fk"
   FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_company_id_companies_id_fk"
   FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_vendor_id_vendors_id_fk"
   FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_posted_payment_id_payments_id_fk"
   FOREIGN KEY ("posted_payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payroll_runs_company_pay_date_idx"
  ON "payroll_runs" USING btree ("company_id", "pay_date" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_runs_company_status_idx"
  ON "payroll_runs" USING btree ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_run_lines_run_idx"
  ON "payroll_run_lines" USING btree ("payroll_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_run_lines_company_vendor_idx"
  ON "payroll_run_lines" USING btree ("company_id", "vendor_id");
