import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { companies, users } from './companies';

/**
 * activity_log
 *
 * Append-only audit trail. Every economic event + (in future slices) every
 * status flip / metadata edit / delete writes a row here. Append-only is
 * enforced by a DB trigger (migration 0037) -- UPDATE and DELETE always
 * throw, by design. To "fix" a wrong row, insert a corrective row that
 * references the bad one's id in details_json.
 *
 * action + entity_type are TEXT (not enums) so new event categories don't
 * require a migration. Conventions:
 *   action       lowercase snake_case verb -- 'posted_entry', 'voided_payment'
 *   entity_type  lowercase snake_case singular -- 'journal_entry', 'invoice'
 *   summary      one-line human-readable description for list views
 *   details_json arbitrary structured context the UI can drill into
 */
export const activityLog = pgTable(
  'activity_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    /** Nullable: company-wide events (e.g. 'closed_period') don't tie to a row. */
    entityId: uuid('entity_id'),
    summary: text('summary').notNull(),
    detailsJson: jsonb('details_json').$type<Record<string, unknown>>(),
  },
  (t) => ({
    companyOccurredIdx: index('activity_log_company_occurred_idx').on(
      t.companyId,
      t.occurredAt,
    ),
    companyEntityIdx: index('activity_log_company_entity_idx').on(
      t.companyId,
      t.entityType,
      t.entityId,
    ),
    companyActorIdx: index('activity_log_company_actor_idx').on(
      t.companyId,
      t.actorUserId,
      t.occurredAt,
    ),
    companyActionIdx: index('activity_log_company_action_idx').on(
      t.companyId,
      t.action,
      t.occurredAt,
    ),
    actionNonempty: check('activity_log_action_nonempty', sql`length(${t.action}) > 0`),
    entityTypeNonempty: check(
      'activity_log_entity_type_nonempty',
      sql`length(${t.entityType}) > 0`,
    ),
    summaryNonempty: check('activity_log_summary_nonempty', sql`length(${t.summary}) > 0`),
  }),
);

export type ActivityLogRow = typeof activityLog.$inferSelect;
export type NewActivityLogRow = typeof activityLog.$inferInsert;
