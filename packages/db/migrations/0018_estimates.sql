DO $$ BEGIN
 CREATE TYPE "public"."estimate_status" AS ENUM('draft', 'sent', 'accepted', 'declined', 'expired', 'converted');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"estimate_number" text NOT NULL,
	"estimate_date" date NOT NULL,
	"expiration_date" date,
	"terms_days" smallint,
	"status" "estimate_status" DEFAULT 'draft' NOT NULL,
	"memo" text,
	"subtotal" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_rate_id" uuid,
	"tax_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"converted_invoice_id" uuid,
	"converted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estimates_converted_consistency" CHECK (("estimates"."status" = 'converted') = ("estimates"."converted_at" IS NOT NULL) AND ("estimates"."status" = 'converted') = ("estimates"."converted_invoice_id" IS NOT NULL)),
	CONSTRAINT "estimates_non_negative_amounts" CHECK ("estimates"."subtotal" >= 0 AND "estimates"."tax_amount" >= 0 AND "estimates"."total" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "estimate_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"estimate_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(19, 4) DEFAULT '0' NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"taxable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estimate_lines_non_negative_amount" CHECK ("estimate_lines"."amount" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimates" ADD CONSTRAINT "estimates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimates" ADD CONSTRAINT "estimates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimates" ADD CONSTRAINT "estimates_tax_rate_id_tax_rates_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rates"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimates" ADD CONSTRAINT "estimates_converted_invoice_id_invoices_id_fk" FOREIGN KEY ("converted_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "estimates_company_number_idx" ON "estimates" USING btree ("company_id","estimate_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimates_company_customer_idx" ON "estimates" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimates_company_status_idx" ON "estimates" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimates_company_date_idx" ON "estimates" USING btree ("company_id","estimate_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_lines_estimate_line_number_idx" ON "estimate_lines" USING btree ("estimate_id","line_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimate_lines_company_estimate_idx" ON "estimate_lines" USING btree ("company_id","estimate_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimate_lines_account_idx" ON "estimate_lines" USING btree ("account_id");
