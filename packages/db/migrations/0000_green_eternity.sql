CREATE TYPE "public"."account_subtype" AS ENUM('bank', 'accounts_receivable', 'other_current_asset', 'fixed_asset', 'other_asset', 'accounts_payable', 'credit_card', 'other_current_liability', 'long_term_liability', 'equity', 'retained_earnings', 'income', 'other_income', 'expense', 'cost_of_goods_sold', 'other_expense');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'expense');--> statement-breakpoint
CREATE TYPE "public"."journal_source_type" AS ENUM('manual', 'invoice', 'bill', 'payment', 'bank_transaction', 'reconciliation', 'payroll', 'import', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'bookkeeper', 'viewer');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"ein" text,
	"fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
	"base_currency" text DEFAULT 'USD' NOT NULL,
	"closed_through_date" date,
	"address" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_fiscal_month_range" CHECK ("companies"."fiscal_year_start_month" BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memberships" (
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'bookkeeper' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_company_id_pk" PRIMARY KEY("user_id","company_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firebase_uid" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"disabled" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"subtype" "account_subtype" NOT NULL,
	"parent_id" uuid,
	"currency" text DEFAULT 'USD' NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" "journal_source_type" NOT NULL,
	"source_id" uuid,
	"memo" text,
	"reference" text,
	"created_by" uuid NOT NULL,
	"reversed_by" uuid,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"fx_rate" numeric(19, 8) DEFAULT '1' NOT NULL,
	"memo" text,
	"dimension_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_debit_xor_credit" CHECK (("journal_lines"."debit" = 0 AND "journal_lines"."credit" > 0) OR ("journal_lines"."debit" > 0 AND "journal_lines"."credit" = 0) OR ("journal_lines"."debit" = 0 AND "journal_lines"."credit" = 0)),
	CONSTRAINT "journal_lines_non_negative" CHECK ("journal_lines"."debit" >= 0 AND "journal_lines"."credit" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_accounts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversed_by_journal_entries_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_name_idx" ON "companies" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_company_idx" ON "memberships" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_firebase_uid_idx" ON "users" USING btree ("firebase_uid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_company_code_idx" ON "accounts" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_company_type_idx" ON "accounts" USING btree ("company_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_parent_idx" ON "accounts" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_entries_company_date_idx" ON "journal_entries" USING btree ("company_id","entry_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_entries_company_source_idx" ON "journal_entries" USING btree ("company_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_entries_reversed_by_idx" ON "journal_entries" USING btree ("reversed_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_lines_entry_idx" ON "journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_lines_account_idx" ON "journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_lines_company_account_idx" ON "journal_lines" USING btree ("company_id","account_id");