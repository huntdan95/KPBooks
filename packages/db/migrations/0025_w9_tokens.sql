-- KPBooks 0025 -- Tokenized W-9 upload links.
--
-- A bookkeeper generates a token; the contractor opens the URL in a normal
-- browser (no login) and uploads their W-9 PDF/photo. Token is single-use:
-- once an upload happens we set used_at + used_document_id and the public
-- route refuses further uploads for that token.

CREATE TABLE IF NOT EXISTS "w9_upload_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"token" text NOT NULL,
	"email_to" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_document_id" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "w9_upload_tokens" ADD CONSTRAINT "w9_upload_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "w9_upload_tokens" ADD CONSTRAINT "w9_upload_tokens_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "w9_upload_tokens" ADD CONSTRAINT "w9_upload_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "w9_upload_tokens" ADD CONSTRAINT "w9_upload_tokens_used_document_id_worker_documents_id_fk" FOREIGN KEY ("used_document_id") REFERENCES "public"."worker_documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "w9_upload_tokens_token_idx" ON "w9_upload_tokens" USING btree ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "w9_upload_tokens_company_idx" ON "w9_upload_tokens" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "w9_upload_tokens_vendor_idx" ON "w9_upload_tokens" USING btree ("vendor_id");
