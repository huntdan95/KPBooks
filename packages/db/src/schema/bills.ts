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
import { billStatusEnum } from './enums';
import { journalEntries } from './ledger';
import { vendors } from './vendors';

/**
 * bills
 * One per A/P document (vendor invoice we've received and owe). Created with
 * status='open' at posting time; the same transaction also writes a
 * journal_entry (DR expense/asset per line, CR A/P) via postEntry.
 *
 * Mirrors invoices in shape and lock-after-post behaviour. To "edit" a posted
 * bill you void and recreate.
 */
export const bills = pgTable(
  'bills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    /** Vendor-supplied invoice/bill number, unique within a company. */
    billNumber: text('bill_number').notNull(),
    billDate: date('bill_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    /** Snapshot of the vendor's payment-terms days at creation time. */
    termsDays: smallint('terms_days'),
    status: billStatusEnum('status').notNull().default('open'),
    memo: text('memo'),
    subtotal: numeric('subtotal', { precision: 19, scale: 4 }).notNull().default('0'),
    /** Reserved for sales-tax / VAT module; currently always 0. */
    taxAmount: numeric('tax_amount', { precision: 19, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 19, scale: 4 }).notNull().default('0'),
    balanceDue: numeric('balance_due', { precision: 19, scale: 4 }).notNull().default('0'),
    postedJournalEntryId: uuid('posted_journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    voidedJournalEntryId: uuid('voided_journal_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'restrict' },
    ),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyNumberIdx: uniqueIndex('bills_company_number_idx').on(t.companyId, t.billNumber),
    companyVendorIdx: index('bills_company_vendor_idx').on(t.companyId, t.vendorId),
    companyStatusIdx: index('bills_company_status_idx').on(t.companyId, t.status),
    companyDateIdx: index('bills_company_date_idx').on(t.companyId, t.billDate),
    voidedConsistency: check(
      'bills_voided_consistency',
      sql`(${t.status} = 'void') = (${t.voidedAt} IS NOT NULL) AND (${t.status} = 'void') = (${t.voidedJournalEntryId} IS NOT NULL)`,
    ),
    nonNegativeAmounts: check(
      'bills_non_negative_amounts',
      sql`${t.subtotal} >= 0 AND ${t.taxAmount} >= 0 AND ${t.total} >= 0 AND ${t.balanceDue} >= 0`,
    ),
  }),
);

/**
 * bill_lines
 * Per-line detail. Each line debits one expense (or asset) account on post;
 * the sum debits across lines balance against the A/P credit.
 */
export const billLines = pgTable(
  'bill_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    /** The expense (or fixed-asset, prepaid, COGS, etc.) account this line debits. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull().default('1'),
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull().default('0'),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    billLineNumberIdx: uniqueIndex('bill_lines_bill_line_number_idx').on(t.billId, t.lineNumber),
    companyBillIdx: index('bill_lines_company_bill_idx').on(t.companyId, t.billId),
    accountIdx: index('bill_lines_account_idx').on(t.accountId),
    nonNegativeAmount: check('bill_lines_non_negative_amount', sql`${t.amount} >= 0`),
  }),
);

export type Bill = typeof bills.$inferSelect;
export type NewBill = typeof bills.$inferInsert;
export type BillLine = typeof billLines.$inferSelect;
export type NewBillLine = typeof billLines.$inferInsert;
