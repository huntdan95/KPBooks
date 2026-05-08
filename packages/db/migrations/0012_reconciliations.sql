CREATE TYPE "public"."reconciliation_status" AS ENUM('in_progress', 'completed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"statement_date" date NOT NULL,
	"statement_balance" numeric(19, 4) NOT NULL,
	"beginning_balance" numeric(19, 4) DEFAULT '0' NOT NULL,
	"status" "reconciliation_status" DEFAULT 'in_progress' NOT NULL,
	"notes" text,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliations_completed_consistency" CHECK (("reconciliations"."status" = 'completed') = ("reconciliations"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "cleared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "reconciliation_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_bank_account_id_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliations_company_account_idx" ON "reconciliations" USING btree ("company_id","bank_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliations_company_date_idx" ON "reconciliations" USING btree ("company_id","statement_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reconciliations_one_in_progress_idx" ON "reconciliations" USING btree ("bank_account_id") WHERE "reconciliations"."status" = 'in_progress';--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_reconciliation_id_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."reconciliations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_reconciliation_idx" ON "bank_transactions" USING btree ("reconciliation_id");--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_cleared_requires_posted" CHECK (("bank_transactions"."cleared_at" IS NULL) OR ("bank_transactions"."status" = 'posted'));--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_cleared_recon_consistency" CHECK (("bank_transactions"."cleared_at" IS NULL) = ("bank_transactions"."reconciliation_id" IS NULL));