import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { bills } from './bills';
import { companies, users } from './companies';
import { vendors } from './vendors';

/**
 * time_entries
 *
 * Billable hours logged against a contractor (vendor). End of period the
 * bookkeeper "builds a bill" -- the service collects every unbilled entry
 * for that vendor and posts a real A/P bill via the existing bills posting
 * service, one bill_line per entry. Each entry then carries its
 * billed_bill_id and becomes immutable until the bill is voided.
 *
 * No invoice-side billing here -- that lives on customers via invoice lines
 * already. This module is strictly the contractor / vendor (A/P) side.
 */
export const timeEntries = pgTable(
  'time_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    entryDate: date('entry_date', { mode: 'string' }).notNull(),
    /** Decimal hours, e.g. 8.0000, 1.7500, 0.2500 (15 minutes). */
    hours: numeric('hours', { precision: 10, scale: 4 }).notNull(),
    /** Hourly rate. Snapshotted at creation; not pulled live from vendor.payRate. */
    rate: numeric('rate', { precision: 19, scale: 4 }).notNull(),
    /** hours * rate. Stored to support GROUP BY / SUM without recomputing. */
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    description: text('description').notNull(),
    /** Free-form project / job tag for v1. Could become FK to projects later. */
    project: text('project'),
    /** Expense account this entry will hit when billed. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    /** When non-null, this entry was rolled into the named bill and is locked. */
    billedBillId: uuid('billed_bill_id').references(() => bills.id, {
      onDelete: 'set null',
    }),
    billedAt: timestamp('billed_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyVendorIdx: index('time_entries_company_vendor_idx').on(t.companyId, t.vendorId),
    companyDateIdx: index('time_entries_company_date_idx').on(t.companyId, t.entryDate),
    billedBillIdx: index('time_entries_billed_bill_idx').on(t.billedBillId),
    hoursPositive: check('time_entries_hours_positive', sql`${t.hours} > 0`),
    rateNonNeg: check('time_entries_rate_non_negative', sql`${t.rate} >= 0`),
    amountNonNeg: check('time_entries_amount_non_negative', sql`${t.amount} >= 0`),
    billedConsistency: check(
      'time_entries_billed_consistency',
      sql`(${t.billedBillId} IS NULL) = (${t.billedAt} IS NULL)`,
    ),
  }),
);

export type TimeEntry = typeof timeEntries.$inferSelect;
export type NewTimeEntry = typeof timeEntries.$inferInsert;
