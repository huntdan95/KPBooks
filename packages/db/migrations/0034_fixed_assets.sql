-- KPBooks 0034 -- Slice #35: Fixed Assets / Depreciation register.
--
-- One row per capitalized asset (vehicles, computers, equipment, leasehold
-- improvements). The bookkeeper records cost + useful life + the three GL
-- accounts (asset / accumulated depreciation / depreciation expense) and
-- the service runs straight-line monthly depreciation, posting one JE per
-- asset-month via the existing posting service.
--
-- State machine:
--   active   -> depreciating; runDepreciation through any month-end
--   disposed -> sold or junked; final disposal JE has been written
--
-- Depreciation history lives in journal_entries (sourceType='manual',
-- sourceId=fixed_asset.id, reference='DEPR-<short>-<YYYY-MM>'). The
-- fixed_assets row itself caches `accumulated_depreciation` and
-- `last_depreciated_through` so the UI doesn't have to re-aggregate
-- on every render. Both are kept in sync inside the same tx as the JE.

DO $$ BEGIN
  CREATE TYPE depreciation_method AS ENUM ('straight_line');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE fixed_asset_status AS ENUM ('active', 'disposed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text,
	"in_service_date" date NOT NULL,
	"cost" numeric(19, 4) NOT NULL,
	"salvage_value" numeric(19, 4) DEFAULT '0' NOT NULL,
	"useful_life_months" integer NOT NULL,
	"method" "depreciation_method" DEFAULT 'straight_line' NOT NULL,
	-- Three GL accounts each asset is hooked to. asset_account is where the
	-- original purchase JE debited (a fixed_asset subtype account); the other
	-- two are where every monthly depreciation JE writes (DR depr_expense,
	-- CR accum_depr). All three must be active at depreciation-run time.
	"asset_account_id" uuid NOT NULL,
	"accum_depr_account_id" uuid NOT NULL,
	"depr_expense_account_id" uuid NOT NULL,
	-- Cached running totals so the list view is cheap. Kept in sync inside
	-- the runDepreciation tx (same tx as the JE insert) and inside the
	-- disposeAsset tx.
	"accumulated_depreciation" numeric(19, 4) DEFAULT '0' NOT NULL,
	"last_depreciated_through" date,
	"status" "fixed_asset_status" DEFAULT 'active' NOT NULL,
	-- Disposal fields, all null until status='disposed'.
	"disposal_date" date,
	"disposal_proceeds" numeric(19, 4),
	"disposal_cash_account_id" uuid,
	"disposal_journal_entry_id" uuid,
	"memo" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_assets_cost_positive" CHECK ("fixed_assets"."cost" > 0),
	CONSTRAINT "fixed_assets_salvage_non_negative" CHECK ("fixed_assets"."salvage_value" >= 0),
	CONSTRAINT "fixed_assets_salvage_lt_cost" CHECK ("fixed_assets"."salvage_value" < "fixed_assets"."cost"),
	CONSTRAINT "fixed_assets_life_positive" CHECK ("fixed_assets"."useful_life_months" > 0),
	CONSTRAINT "fixed_assets_accum_non_negative" CHECK ("fixed_assets"."accumulated_depreciation" >= 0),
	CONSTRAINT "fixed_assets_accum_lte_depreciable" CHECK (
	  "fixed_assets"."accumulated_depreciation" <= ("fixed_assets"."cost" - "fixed_assets"."salvage_value")
	),
	CONSTRAINT "fixed_assets_disposed_consistency" CHECK (
	  ("fixed_assets"."status" = 'disposed') = ("fixed_assets"."disposal_date" IS NOT NULL)
	),
	CONSTRAINT "fixed_assets_disposal_after_in_service" CHECK (
	  "fixed_assets"."disposal_date" IS NULL OR "fixed_assets"."disposal_date" >= "fixed_assets"."in_service_date"
	),
	CONSTRAINT "fixed_assets_disposal_proceeds_non_negative" CHECK (
	  "fixed_assets"."disposal_proceeds" IS NULL OR "fixed_assets"."disposal_proceeds" >= 0
	)
);

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_company_id_companies_id_fk"
   FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_asset_account_id_accounts_id_fk"
   FOREIGN KEY ("asset_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_accum_depr_account_id_accounts_id_fk"
   FOREIGN KEY ("accum_depr_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_depr_expense_account_id_accounts_id_fk"
   FOREIGN KEY ("depr_expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_cash_account_id_accounts_id_fk"
   FOREIGN KEY ("disposal_cash_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_journal_entry_id_journal_entries_id_fk"
   FOREIGN KEY ("disposal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_user_id_users_id_fk"
   FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fixed_assets_company_status_idx"
  ON "fixed_assets" USING btree ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fixed_assets_company_in_service_idx"
  ON "fixed_assets" USING btree ("company_id", "in_service_date" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fixed_assets_asset_account_idx"
  ON "fixed_assets" USING btree ("asset_account_id");
