CREATE TYPE "public"."ai_confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."bank_transaction_status" AS ENUM('unmatched', 'suggested', 'posted', 'ignored');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"transaction_date" date NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"balance" numeric(19, 4),
	"status" "bank_transaction_status" DEFAULT 'unmatched' NOT NULL,
	"suggested_account_id" uuid,
	"suggested_confidence" "ai_confidence",
	"suggested_reason" text,
	"posted_journal_entry_id" uuid,
	"import_batch_id" uuid NOT NULL,
	"raw_csv_line" text,
	"dedupe_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transactions_nonzero_amount" CHECK ("bank_transactions"."amount" <> 0),
	CONSTRAINT "bank_transactions_posted_consistency" CHECK (("bank_transactions"."status" = 'posted') = ("bank_transactions"."posted_journal_entry_id" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_suggested_account_id_accounts_id_fk" FOREIGN KEY ("suggested_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_posted_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("posted_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_company_account_idx" ON "bank_transactions" USING btree ("company_id","bank_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_company_status_idx" ON "bank_transactions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_company_date_idx" ON "bank_transactions" USING btree ("company_id","transaction_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_import_batch_idx" ON "bank_transactions" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_company_dedupe_idx" ON "bank_transactions" USING btree ("company_id","dedupe_hash");