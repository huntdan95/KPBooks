CREATE TYPE "public"."bill_status" AS ENUM('open', 'partial', 'paid', 'void');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(19, 4) DEFAULT '0' NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_lines_non_negative_amount" CHECK ("bill_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"bill_number" text NOT NULL,
	"bill_date" date NOT NULL,
	"due_date" date NOT NULL,
	"terms_days" smallint,
	"status" "bill_status" DEFAULT 'open' NOT NULL,
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
	CONSTRAINT "bills_voided_consistency" CHECK (("bills"."status" = 'void') = ("bills"."voided_at" IS NOT NULL) AND ("bills"."status" = 'void') = ("bills"."voided_journal_entry_id" IS NOT NULL)),
	CONSTRAINT "bills_non_negative_amounts" CHECK ("bills"."subtotal" >= 0 AND "bills"."tax_amount" >= 0 AND "bills"."total" >= 0 AND "bills"."balance_due" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_posted_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("posted_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_voided_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("voided_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bill_lines_bill_line_number_idx" ON "bill_lines" USING btree ("bill_id","line_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bill_lines_company_bill_idx" ON "bill_lines" USING btree ("company_id","bill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bill_lines_account_idx" ON "bill_lines" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bills_company_number_idx" ON "bills" USING btree ("company_id","bill_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bills_company_vendor_idx" ON "bills" USING btree ("company_id","vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bills_company_status_idx" ON "bills" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bills_company_date_idx" ON "bills" USING btree ("company_id","bill_date");