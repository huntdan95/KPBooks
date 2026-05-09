-- KPBooks 0030 -- Service / non-inventory item catalog.
--
-- Saves the bookkeeper from re-typing description + price + GL account
-- every time they invoice. An item can be sales-only ("Site visit @ $150"
-- on invoices), purchase-only ("Lumber @ $whatever" on bills), or both.
-- Inventory items (qty tracking + COGS journal entries) are intentionally
-- NOT in this slice -- adding them is a separate workflow with its own
-- schema needs (qty on hand, average cost, purchase batches).

DO $$ BEGIN
 CREATE TYPE "public"."item_type" AS ENUM('service', 'non_inventory');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"item_type" "item_type" DEFAULT 'service' NOT NULL,
	"sales_description" text,
	"sales_price" numeric(19, 4) DEFAULT '0' NOT NULL,
	"sales_account_id" uuid,
	"taxable" boolean DEFAULT false NOT NULL,
	"purchase_description" text,
	"purchase_cost" numeric(19, 4),
	"purchase_account_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_sales_price_non_negative" CHECK ("items"."sales_price" >= 0),
	CONSTRAINT "items_purchase_cost_non_negative" CHECK ("items"."purchase_cost" IS NULL OR "items"."purchase_cost" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_sales_account_id_accounts_id_fk" FOREIGN KEY ("sales_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_purchase_account_id_accounts_id_fk" FOREIGN KEY ("purchase_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_company_active_idx" ON "items" USING btree ("company_id","is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_company_name_idx" ON "items" USING btree ("company_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "items_company_sku_idx" ON "items" USING btree ("company_id","sku") WHERE "items"."sku" IS NOT NULL;
