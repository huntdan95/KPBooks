import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { recurringFrequencyEnum, recurringTemplateKindEnum } from './enums';

/**
 * recurring_templates
 *
 * Recurring invoice / bill templates. Each row is a payload + schedule;
 * firing a template resolves the payload through the existing invoice/bill
 * posting service (so the same validation + ledger writes happen as for a
 * one-off invoice or bill) and bumps next_run_date forward by frequency.
 *
 * Manual fire today via "Run now" / "Run all due"; cron-driven fire is a v2
 * concern (the per-tenant Postgres GUC scoping makes a worker simple but
 * adds infra; defer until usage demands it).
 *
 * day_of_month=31 means "last day of month" so February gets 28/29, April
 * gets 30, etc. -- avoids skipping months.
 */
export const recurringTemplates = pgTable(
  'recurring_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    kind: recurringTemplateKindEnum('kind').notNull(),
    name: text('name').notNull(),
    frequency: recurringFrequencyEnum('frequency').notNull(),
    dayOfMonth: smallint('day_of_month'),
    dayOfWeek: smallint('day_of_week'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    nextRunDate: date('next_run_date', { mode: 'string' }).notNull(),
    lastRunDate: date('last_run_date', { mode: 'string' }),
    lastRunDocumentId: uuid('last_run_document_id'),
    isActive: boolean('is_active').notNull().default(true),
    /**
     * Snapshot of the template body. Shape:
     * {
     *   customerId?: string;     // for invoices
     *   vendorId?: string;       // for bills
     *   termsDays?: number;
     *   memo?: string;
     *   taxRateId?: string;
     *   numberPrefix?: string;   // e.g. "REC-" appended to a date stamp
     *   lines: Array<{
     *     accountId: string;
     *     description: string;
     *     quantity: string | number;
     *     unitPrice: string | number;
     *     taxable: boolean;
     *   }>;
     * }
     */
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    runCount: integer('run_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyActiveIdx: index('recurring_templates_company_active_idx').on(
      t.companyId,
      t.isActive,
      t.nextRunDate,
    ),
    companyKindIdx: index('recurring_templates_company_kind_idx').on(t.companyId, t.kind),
    domRange: check(
      'recurring_templates_dom_range',
      sql`${t.dayOfMonth} IS NULL OR (${t.dayOfMonth} >= 1 AND ${t.dayOfMonth} <= 31)`,
    ),
    dowRange: check(
      'recurring_templates_dow_range',
      sql`${t.dayOfWeek} IS NULL OR (${t.dayOfWeek} >= 0 AND ${t.dayOfWeek} <= 6)`,
    ),
  }),
);

export type RecurringTemplate = typeof recurringTemplates.$inferSelect;
export type NewRecurringTemplate = typeof recurringTemplates.$inferInsert;
