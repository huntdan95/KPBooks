import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';

/**
 * tax_rates
 * Per-company sales-tax rate definitions. Each rate has a name (e.g. "CA
 * Sales Tax 8.75%"), a percentage stored as NUMERIC(8,4) (8.7500 = 8.75%),
 * and an active flag. Tax computation on invoices: rate.ratePercent * sum
 * of taxable line amounts.
 *
 * v1 keeps it simple: no tax-agency vendor link, no per-rate payable
 * account override (we always credit the seeded "Sales Tax Payable"
 * account, looked up by subtype). Add those in slice #N+ when multi-
 * jurisdiction reporting becomes a requirement.
 */
export const taxRates = pgTable(
  'tax_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Percentage form: 8.7500 means 8.75%. */
    ratePercent: numeric('rate_percent', { precision: 8, scale: 4 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyNameIdx: uniqueIndex('tax_rates_company_name_idx').on(t.companyId, t.name),
    companyActiveIdx: index('tax_rates_company_active_idx').on(t.companyId, t.isActive),
    rateRange: check(
      'tax_rates_rate_range',
      sql`${t.ratePercent} >= 0 AND ${t.ratePercent} <= 100`,
    ),
  }),
);

export type TaxRate = typeof taxRates.$inferSelect;
export type NewTaxRate = typeof taxRates.$inferInsert;
