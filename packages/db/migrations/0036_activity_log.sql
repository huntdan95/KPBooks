-- KPBooks 0036 -- Slice #38: Activity log / audit trail.
--
-- Append-only table that records every economic event (and, in future
-- slices, status flips + edits + deletes). Slice #38 wires only the
-- postEntry chokepoint -- which captures invoices, bills, payments,
-- journal entries, payroll-run posts, depreciation, disposals, all
-- automatically, since every JE goes through postEntry. Future slices
-- add wiring for non-JE events (void operations, vendor metadata
-- edits, login events, etc.).
--
-- The table is append-only by trigger (0037) -- once a row is in
-- activity_log it can't be UPDATE'd or DELETE'd by app code. Mutating
-- the audit trail would defeat its purpose.
--
-- action + entity_type are TEXT (not enums) on purpose -- new event
-- categories should not require a migration. The UI will surface
-- whatever values exist, so naming conventions matter:
--   action:      verb, lowercase snake_case, e.g. 'posted_entry',
--                'voided_payment', 'edited_vendor', 'created_asset'
--   entity_type: lowercase snake_case singular, e.g. 'journal_entry',
--                'payment', 'invoice', 'fixed_asset'
-- entity_id may be NULL for company-wide events (e.g. 'closed_period').

CREATE TABLE IF NOT EXISTS "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"summary" text NOT NULL,
	"details_json" jsonb,
	CONSTRAINT "activity_log_action_nonempty" CHECK (length("action") > 0),
	CONSTRAINT "activity_log_entity_type_nonempty" CHECK (length("entity_type") > 0),
	CONSTRAINT "activity_log_summary_nonempty" CHECK (length("summary") > 0)
);

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_company_id_companies_id_fk"
   FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_user_id_users_id_fk"
   FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "activity_log_company_occurred_idx"
  ON "activity_log" USING btree ("company_id", "occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_company_entity_idx"
  ON "activity_log" USING btree ("company_id", "entity_type", "entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_company_actor_idx"
  ON "activity_log" USING btree ("company_id", "actor_user_id", "occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_company_action_idx"
  ON "activity_log" USING btree ("company_id", "action", "occurred_at" DESC);
