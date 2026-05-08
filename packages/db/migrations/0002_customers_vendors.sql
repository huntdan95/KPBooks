CREATE TABLE IF NOT EXISTS "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"company_name" text,
	"account_number" text,
	"email" text,
	"phone" text,
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"default_terms_days" smallint,
	"tax_exempt" boolean DEFAULT false NOT NULL,
	"tax_id" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"opening_balance" numeric(19, 4) DEFAULT '0' NOT NULL,
	"opening_balance_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"company_name" text,
	"account_number" text,
	"email" text,
	"phone" text,
	"mailing_address" jsonb,
	"default_terms_days" smallint,
	"is_1099_vendor" boolean DEFAULT false NOT NULL,
	"tax_id" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"opening_balance" numeric(19, 4) DEFAULT '0' NOT NULL,
	"opening_balance_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendors" ADD CONSTRAINT "vendors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_company_account_number_idx" ON "customers" USING btree ("company_id","account_number") WHERE "customers"."account_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_company_display_name_idx" ON "customers" USING btree ("company_id","display_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_company_active_idx" ON "customers" USING btree ("company_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendors_company_account_number_idx" ON "vendors" USING btree ("company_id","account_number") WHERE "vendors"."account_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendors_company_display_name_idx" ON "vendors" USING btree ("company_id","display_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendors_company_active_idx" ON "vendors" USING btree ("company_id","is_active");