import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { companies } from './companies';
import { customers } from './customers';
import { invoices } from './invoices';
import { journalEntries } from './ledger';
import { paymentMethodEnum, paymentStatusEnum, paymentTypeEnum } from './enums';
import { vendors } from './vendors';

/**
 * payments
 * One per money movement on the A/R or A/P side. paymentType discriminates:
 *   customer_received -- DR bank, CR A/R; reduces invoice balance_due
 *   vendor_sent       -- DR A/P, CR bank; reduces bill balance_due
 *
 * For v1, the sum of payment_applications.amount must equal payments.amount
 * exactly (no unapplied portion). Relax in a later slice with an "unapplied
 * customer payments" liability account.
 *
 * Locked after post -- to "edit", void and recreate.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    paymentType: paymentTypeEnum('payment_type').notNull(),
    /** Required when paymentType = customer_received. */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    /** Required when paymentType = vendor_sent. */
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
    paymentDate: date('payment_date', { mode: 'string' }).notNull(),
    paymentMethod: paymentMethodEnum('payment_method').notNull(),
    /** Check #, transfer reference, etc. */
    reference: text('reference'),
    /** The cash/credit account on our books that's debited (received) or credited (sent). */
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    memo: text('memo'),
    status: paymentStatusEnum('status').notNull().default('posted'),
    postedJournalEntryId: uuid('posted_journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    voidedJournalEntryId: uuid('voided_journal_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'restrict' },
    ),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    /** Subcontractor lien-waiver sign-off: was a signed waiver received for
     *  this specific payment? Only meaningful when paymentType=vendor_sent
     *  and the vendor is a 1099 subcontractor. Drives the
     *  "missing waiver" warning in Workers / Payments. */
    lienWaiverReceived: boolean('lien_waiver_received'),
    lienWaiverReceivedDate: date('lien_waiver_received_date', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyDateIdx: index('payments_company_date_idx').on(t.companyId, t.paymentDate),
    companyCustomerIdx: index('payments_company_customer_idx').on(t.companyId, t.customerId),
    companyVendorIdx: index('payments_company_vendor_idx').on(t.companyId, t.vendorId),
    companyStatusIdx: index('payments_company_status_idx').on(t.companyId, t.status),
    counterpartyConsistency: check(
      'payments_counterparty_consistency',
      sql`(${t.paymentType} = 'customer_received' AND ${t.customerId} IS NOT NULL AND ${t.vendorId} IS NULL)
       OR (${t.paymentType} = 'vendor_sent' AND ${t.vendorId} IS NOT NULL AND ${t.customerId} IS NULL)`,
    ),
    voidedConsistency: check(
      'payments_voided_consistency',
      sql`(${t.status} = 'void') = (${t.voidedAt} IS NOT NULL) AND (${t.status} = 'void') = (${t.voidedJournalEntryId} IS NOT NULL)`,
    ),
    positiveAmount: check('payments_positive_amount', sql`${t.amount} > 0`),
  }),
);

/**
 * payment_applications
 * Each row applies a portion of a payment to one invoice or one bill.
 * Customer payments link to invoices; vendor payments link to bills (enforced
 * by the parent payment's type via app code -- the schema only checks XOR
 * between invoiceId and billId).
 */
export const paymentApplications = pgTable(
  'payment_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'restrict' }),
    billId: uuid('bill_id').references(() => bills.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    paymentIdx: index('payment_applications_payment_idx').on(t.paymentId),
    invoiceIdx: index('payment_applications_invoice_idx').on(t.invoiceId),
    billIdx: index('payment_applications_bill_idx').on(t.billId),
    targetXor: check(
      'payment_applications_target_xor',
      sql`(${t.invoiceId} IS NOT NULL AND ${t.billId} IS NULL) OR (${t.invoiceId} IS NULL AND ${t.billId} IS NOT NULL)`,
    ),
    positiveAmount: check('payment_applications_positive_amount', sql`${t.amount} > 0`),
  }),
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type PaymentApplication = typeof paymentApplications.$inferSelect;
export type NewPaymentApplication = typeof paymentApplications.$inferInsert;
