CREATE TYPE "public"."invoice_status" AS ENUM('open', 'partial', 'paid', 'void');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(19, 4) DEFAULT '0' NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_lines_non_negative_amount" CHECK ("invoice_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"terms_days" smallint,
	"status" "invoice_status" DEFAULT 'open' NOT NULL,
	"memo" text,
	"subtotal" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"balance_due" numeric(19, 4) DEFAULT '0' NOT NULL,
	"posted_journal_entry_id" uuid NOT NULL,
	"voided_journal_entry_id" uuid,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_voided_consistency" CHECK (("invoices"."status" = 'void') = ("invoices"."voided_at" IS NOT NULL) AND ("invoices"."status" = 'void') = ("invoices"."voided_journal_entry_id" IS NOT NULL)),
	CONSTRAINT "invoices_non_negative_amounts" CHECK ("invoices"."subtotal" >= 0 AND "invoices"."tax_amount" >= 0 AND "invoices"."total" >= 0 AND "invoices"."balance_due" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_posted_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("posted_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("voided_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_lines_invoice_line_number_idx" ON "invoice_lines" USING btree ("invoice_id","line_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_lines_company_invoice_idx" ON "invoice_lines" USING btree ("company_id","invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_lines_account_idx" ON "invoice_lines" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_company_number_idx" ON "invoices" USING btree ("company_id","invoice_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_company_customer_idx" ON "invoices" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_company_status_idx" ON "invoices" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_company_date_idx" ON "invoices" USING btree ("company_id","invoice_date");