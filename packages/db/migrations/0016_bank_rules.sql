CREATE TABLE IF NOT EXISTS "bank_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bank_account_id" uuid,
	"name" text NOT NULL,
	"match_type" text DEFAULT 'contains' NOT NULL,
	"match_value" text NOT NULL,
	"amount_sign" text DEFAULT 'any' NOT NULL,
	"target_account_id" uuid NOT NULL,
	"memo_template" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_rules_match_type_chk" CHECK ("bank_rules"."match_type" IN ('contains','starts_with','ends_with','exact','regex')),
	CONSTRAINT "bank_rules_amount_sign_chk" CHECK ("bank_rules"."amount_sign" IN ('any','positive','negative')),
	CONSTRAINT "bank_rules_match_value_length" CHECK (length("bank_rules"."match_value") >= 1 AND length("bank_rules"."match_value") <= 500)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_bank_account_id_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_target_account_id_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_rules_company_active_idx" ON "bank_rules" USING btree ("company_id","is_active","priority");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_rules_company_account_idx" ON "bank_rules" USING btree ("company_id","bank_account_id");
