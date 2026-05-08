import { sql } from 'drizzle-orm';
import {
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
import { invoiceStatusEnum } from './enums';
import { journalEntries } from './ledger';

/**
 * invoices
 * One per A/R document. Created with status='open' at posting time; the same
 * transaction also writes a journal_entry (DR A/R, CR Revenue per line) via
 * postEntry. invoices.posted_journal_entry_id points back to that entry.
 *
 * Invoices are locked after posting — to "edit" you void and recreate. This
 * keeps the audit trail honest (matches the locked-entry rule on journal_*).
 */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    /** User-facing invoice number, unique within a company. Auto-suggested by API but always user-set. */
    invoiceNumber: text('invoice_number').notNull(),
    invoiceDate: date('invoice_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    /** Snapshot of the customer's payment-terms days at creation time. */
    termsDays: smallint('terms_days'),
    status: invoiceStatusEnum('status').notNull().default('open'),
    memo: text('memo'),
    /** Subtotal of all lines before any future tax. */
    subtotal: numeric('subtotal', { precision: 19, scale: 4 }).notNull().default('0'),
    /** Reserved for sales-tax module; currently always 0. */
    taxAmount: numeric('tax_amount', { precision: 19, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 19, scale: 4 }).notNull().default('0'),
    /**
     * total - applied payments. Maintained by the payments module when it
     * lands; for now equals total when status='open', 0 when 'paid' or 'void'.
     */
    balanceDue: numeric('balance_due', { precision: 19, scale: 4 }).notNull().default('0'),
    /** The posted journal_entry (always present — every invoice posts on save). */
    postedJournalEntryId: uuid('posted_journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    /** When voided, this points at the reversing journal_entry. */
    voidedJournalEntryId: uuid('voided_journal_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'restrict' },
    ),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyNumberIdx: uniqueIndex('invoices_company_number_idx').on(t.companyId, t.invoiceNumber),
    companyCustomerIdx: index('invoices_company_customer_idx').on(t.companyId, t.customerId),
    companyStatusIdx: index('invoices_company_status_idx').on(t.companyId, t.status),
    companyDateIdx: index('invoices_company_date_idx').on(t.companyId, t.invoiceDate),
    voidedConsistency: check(
      'invoices_voided_consistency',
      sql`(${t.status} = 'void') = (${t.voidedAt} IS NOT NULL) AND (${t.status} = 'void') = (${t.voidedJournalEntryId} IS NOT NULL)`,
    ),
    nonNegativeAmounts: check(
      'invoices_non_negative_amounts',
      sql`${t.subtotal} >= 0 AND ${t.taxAmount} >= 0 AND ${t.total} >= 0 AND ${t.balanceDue} >= 0`,
    ),
  }),
);

/**
 * invoice_lines
 * Per-line detail for an invoice. Each line credits one revenue account on
 * post; the sum credits across lines balance against the A/R debit.
 */
export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** 1-based line ordering. */
    lineNumber: integer('line_number').notNull(),
    /** The revenue (or other-income) account this line credits. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull().default('1'),
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull().default('0'),
    /** quantity * unit_price — the actual amount that posts to the GL. */
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoiceLineNumberIdx: uniqueIndex('invoice_lines_invoice_line_number_idx').on(t.invoiceId, t.lineNumber),
    companyInvoiceIdx: index('invoice_lines_company_invoice_idx').on(t.companyId, t.invoiceId),
    accountIdx: index('invoice_lines_account_idx').on(t.accountId),
    nonNegativeAmount: check('invoice_lines_non_negative_amount', sql`${t.amount} >= 0`),
  }),
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type NewInvoiceLine = typeof invoiceLines.$inferInsert;
