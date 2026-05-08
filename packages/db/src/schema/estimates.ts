import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { companies } from './companies';
import { customers } from './customers';
import { estimateStatusEnum } from './enums';
import { invoices } from './invoices';
import { taxRates } from './tax-rates';

/**
 * estimates
 * Quote / proposal documents that precede an invoice. Estimates do NOT post
 * to the ledger -- they're purely a sales-pipeline artefact. When the
 * customer accepts and the user clicks "convert to invoice", the estimate
 * snapshots its lines into a new invoice (which DOES post via postEntry),
 * and the estimate flips to status='converted' with convertedInvoiceId set.
 *
 * Status lifecycle:
 *   draft     -- created, not yet sent
 *   sent      -- emailed/printed for the customer (no enforcement; just a flag)
 *   accepted  -- customer agreed; ready to convert
 *   declined  -- customer rejected
 *   expired   -- past expiration_date (status flipped manually or by future cron)
 *   converted -- terminal; convertedInvoiceId set, edits locked
 *
 * No lock-after-post trigger here -- estimates are mutable up until conversion.
 * Once converted, the row is locked (cannot edit, cannot delete) so the
 * audit trail from quote-to-invoice stays intact.
 */
export const estimates = pgTable(
  'estimates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    /** User-facing estimate number, unique within a company. */
    estimateNumber: text('estimate_number').notNull(),
    estimateDate: date('estimate_date', { mode: 'string' }).notNull(),
    /** Optional cutoff after which the quote is no longer valid. */
    expirationDate: date('expiration_date', { mode: 'string' }),
    /** Snapshot of the customer's payment-terms days (carries to the invoice). */
    termsDays: smallint('terms_days'),
    status: estimateStatusEnum('status').notNull().default('draft'),
    memo: text('memo'),
    /** Subtotal of all lines before tax. */
    subtotal: numeric('subtotal', { precision: 19, scale: 4 }).notNull().default('0'),
    /** Tax rate applied to taxable lines. NULL = no tax. */
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id, { onDelete: 'restrict' }),
    /** Computed tax = sum(taxable line amounts) * (rate_percent / 100). */
    taxAmount: numeric('tax_amount', { precision: 19, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 19, scale: 4 }).notNull().default('0'),
    /** Set when status flips to 'converted'; FK to the new invoice. */
    convertedInvoiceId: uuid('converted_invoice_id').references(() => invoices.id, {
      onDelete: 'set null',
    }),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyNumberIdx: uniqueIndex('estimates_company_number_idx').on(t.companyId, t.estimateNumber),
    companyCustomerIdx: index('estimates_company_customer_idx').on(t.companyId, t.customerId),
    companyStatusIdx: index('estimates_company_status_idx').on(t.companyId, t.status),
    companyDateIdx: index('estimates_company_date_idx').on(t.companyId, t.estimateDate),
    convertedConsistency: check(
      'estimates_converted_consistency',
      sql`(${t.status} = 'converted') = (${t.convertedAt} IS NOT NULL) AND (${t.status} = 'converted') = (${t.convertedInvoiceId} IS NOT NULL)`,
    ),
    nonNegativeAmounts: check(
      'estimates_non_negative_amounts',
      sql`${t.subtotal} >= 0 AND ${t.taxAmount} >= 0 AND ${t.total} >= 0`,
    ),
  }),
);

export const estimateLines = pgTable(
  'estimate_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    estimateId: uuid('estimate_id')
      .notNull()
      .references(() => estimates.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    /** Income/revenue account this line will credit when converted to an invoice. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull().default('1'),
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull().default('0'),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    taxable: boolean('taxable').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    estimateLineNumberIdx: uniqueIndex('estimate_lines_estimate_line_number_idx').on(
      t.estimateId,
      t.lineNumber,
    ),
    companyEstimateIdx: index('estimate_lines_company_estimate_idx').on(t.companyId, t.estimateId),
    accountIdx: index('estimate_lines_account_idx').on(t.accountId),
    nonNegativeAmount: check('estimate_lines_non_negative_amount', sql`${t.amount} >= 0`),
  }),
);

export type Estimate = typeof estimates.$inferSelect;
export type NewEstimate = typeof estimates.$inferInsert;
export type EstimateLine = typeof estimateLines.$inferSelect;
export type NewEstimateLine = typeof estimateLines.$inferInsert;
