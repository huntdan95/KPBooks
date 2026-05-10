-- KPBooks 0040 -- Slice #46: general document repository.
--
-- Distinct from worker_documents (which stays scoped to per-vendor HR docs:
-- W-9 / W-4 / I-9 / contracts / insurance / WC / DD-auth). This table is for
-- everything else a CPA wants to keep alongside the books: tax returns,
-- received 1099s, signed W-9s / W-2s archived for the company, 941s, expense
-- receipts, bank statements, service contracts, correspondence, exported
-- financial reports.
--
-- Storage: file_data bytea inline, same pattern as worker_documents. 10 MiB
-- cap per file (matches the existing 16 MiB body limit minus base64 overhead).
-- For ~250 clients × ~50 docs/yr × ~1 MB avg = ~12 GB, well within Postgres
-- comfort. If we outgrow inline storage, swap file_data for a Cloud Storage
-- object_path -- no client change needed since downloads stream through the
-- API.
--
-- category: TEXT + CHECK rather than a PG enum so adding new categories
-- never requires a migration (only a code change to the constraint -- which
-- is itself trivial via DROP CONSTRAINT / ADD CONSTRAINT).
--
-- related_entity_type + related_entity_id: optional pointer to any other row
-- in the system. NOT a real FK -- different docs link to different tables.
-- The UI shows the link as context; it doesn't enforce referential integrity
-- across this fan-out.

CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"category" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"file_data" bytea NOT NULL,
	"sha256" text NOT NULL,
	"description" text,
	"tags" text[] NOT NULL DEFAULT ARRAY[]::text[],
	"tax_year" smallint,
	"related_entity_type" text,
	"related_entity_id" uuid,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "documents_filename_nonempty" CHECK (length("filename") > 0),
	CONSTRAINT "documents_size_chk" CHECK ("file_size_bytes" > 0 AND "file_size_bytes" <= 10485760),
	CONSTRAINT "documents_category_chk" CHECK ("category" IN (
	  'tax_return',
	  'w9',
	  'w2',
	  'form_1099',
	  'form_941',
	  'receipt',
	  'statement',
	  'contract',
	  'correspondence',
	  'financial_report',
	  'other'
	)),
	CONSTRAINT "documents_tax_year_range" CHECK (
	  "tax_year" IS NULL OR ("tax_year" >= 1990 AND "tax_year" <= 2100)
	),
	CONSTRAINT "documents_related_pair" CHECK (
	  ("related_entity_type" IS NULL) = ("related_entity_id" IS NULL)
	)
);

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk"
   FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk"
   FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "documents_company_category_created_idx"
  ON "documents" USING btree ("company_id", "category", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_company_tax_year_idx"
  ON "documents" USING btree ("company_id", "tax_year")
  WHERE "tax_year" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_company_entity_idx"
  ON "documents" USING btree ("company_id", "related_entity_type", "related_entity_id")
  WHERE "related_entity_type" IS NOT NULL;
--> statement-breakpoint
-- Filename search uses a case-insensitive expression index so ILIKE 'foo%'
-- can use the index on the live (non-deleted) subset.
CREATE INDEX IF NOT EXISTS "documents_company_filename_lower_idx"
  ON "documents" USING btree ("company_id", lower("filename"))
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
-- Live (non-deleted) lookup is the hot path; partial index keeps it small.
CREATE INDEX IF NOT EXISTS "documents_company_live_idx"
  ON "documents" USING btree ("company_id", "created_at" DESC)
  WHERE "deleted_at" IS NULL;
