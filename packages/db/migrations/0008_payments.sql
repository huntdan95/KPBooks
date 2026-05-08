CREATE TYPE "public"."payment_method" AS ENUM('check', 'cash', 'eft', 'credit_card', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('posted', 'void');--> statement-breakpoint
CREATE TYPE "public"."payment_type" AS ENUM('customer_received', 'vendor_sent');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid,
	"bill_id" uuid,
	"amount" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_applications_target_xor" CHECK (("payment_applications"."invoice_id" IS NOT NULL AND "payment_applications"."bill_id" IS NULL) OR ("payment_applications"."invoice_id" IS NULL AND "payment_applications"."bill_id" IS NOT NULL)),
	CONSTRAINT "payment_applications_positive_amount" CHECK ("payment_applications"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payment_type" "payment_type" NOT NULL,
	"customer_id" uuid,
	"vendor_id" uuid,
	"payment_date" date NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"reference" text,
	"bank_account_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"memo" text,
	"status" "payment_status" DEFAULT 'posted' NOT NULL,
	"posted_journal_entry_id" uuid NOT NULL,
	"voided_journal_entry_id" uuid,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_counterparty_consistency" CHECK (("payments"."payment_type" = 'customer_received' AND "payments"."customer_id" IS NOT NULL AND "payments"."vendor_id" IS NULL)
       OR ("payments"."payment_type" = 'vendor_sent' AND "payments"."vendor_id" IS NOT NULL AND "payments"."customer_id" IS NULL)),
	CONSTRAINT "payments_voided_consistency" CHECK (("payments"."status" = 'void') = ("payments"."voided_at" IS NOT NULL) AND ("payments"."status" = 'void') = ("payments"."voided_journal_entry_id" IS NOT NULL)),
	CONSTRAINT "payments_positive_amount" CHECK ("payments"."amount" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_bank_account_id_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_posted_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("posted_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("voided_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_applications_payment_idx" ON "payment_applications" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_applications_invoice_idx" ON "payment_applications" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_applications_bill_idx" ON "payment_applications" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_company_date_idx" ON "payments" USING btree ("company_id","payment_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_company_customer_idx" ON "payments" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_company_vendor_idx" ON "payments" USING btree ("company_id","vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_company_status_idx" ON "payments" USING btree ("company_id","status");