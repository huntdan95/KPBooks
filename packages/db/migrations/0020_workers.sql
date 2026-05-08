-- KPBooks 0020 -- Worker fields on vendors + worker_documents table.
--
-- The CPA's clients pay almost everyone via 1099, so workers / contractors
-- ARE just vendors in the accounting system. Rather than fork the data, we
-- extend vendors with worker-specific fields and add a documents table for
-- W-9 / W-4 / I-9 / contracts. The Workers UI is a focused view of vendors
-- where worker_type IN ('contractor','employee'); 1099 prep continues to
-- pull from the same vendors using the existing is_1099_vendor flag.

DO $$ BEGIN
 CREATE TYPE "public"."worker_type" AS ENUM('contractor', 'employee', 'not_a_worker');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."pay_rate_basis" AS ENUM('hourly', 'weekly', 'biweekly', 'monthly', 'annually', 'project');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "worker_type" "worker_type" DEFAULT 'not_a_worker' NOT NULL;
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "title" text;
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "hire_date" date;
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "termination_date" date;
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "pay_rate" numeric(19, 4);
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "pay_rate_basis" "pay_rate_basis";
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "default_expense_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "workers_comp_class" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendors" ADD CONSTRAINT "vendors_default_expense_account_id_accounts_id_fk" FOREIGN KEY ("default_expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendors_company_worker_type_idx" ON "vendors" USING btree ("company_id","worker_type");
--> statement-breakpoint
-- Worker documents (W-9 / W-4 / I-9 / contracts / insurance / workers-comp / other)
-- File data is stored as bytea inline. Cap individual files at 10 MiB.
CREATE TABLE IF NOT EXISTS "worker_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"file_data" bytea NOT NULL,
	"uploaded_by_user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_documents_document_type_chk" CHECK ("worker_documents"."document_type" IN ('w9','w4','i9','contract','insurance','workers_comp','direct_deposit_auth','other')),
	CONSTRAINT "worker_documents_size_chk" CHECK ("worker_documents"."file_size_bytes" > 0 AND "worker_documents"."file_size_bytes" <= 10485760)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "worker_documents" ADD CONSTRAINT "worker_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "worker_documents" ADD CONSTRAINT "worker_documents_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "worker_documents" ADD CONSTRAINT "worker_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_documents_company_vendor_idx" ON "worker_documents" USING btree ("company_id","vendor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_documents_company_type_idx" ON "worker_documents" USING btree ("company_id","document_type");
