import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';

/**
 * customers
 * One row per customer of a company. Used as the counterparty on invoices and
 * received payments. `display_name` is the user-facing label (often "Acme Corp"
 * or "Smith, John"); `company_name` is set separately when the contact is an
 * individual at a company.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    companyName: text('company_name'),
    /** Client-assigned customer number, e.g. "C-1042". Optional but unique within a company when set. */
    accountNumber: text('account_number'),
    email: text('email'),
    phone: text('phone'),
    /** { street1, street2, city, state, postalCode, country } */
    billingAddress: jsonb('billing_address').$type<Record<string, unknown>>(),
    shippingAddress: jsonb('shipping_address').$type<Record<string, unknown>>(),
    /** Default payment terms in days (Net 30 = 30). Null = "Due on receipt". */
    defaultTermsDays: smallint('default_terms_days'),
    taxExempt: boolean('tax_exempt').notNull().default(false),
    /** Resale-cert / tax-exempt ID; only meaningful when tax_exempt = true. */
    taxId: text('tax_id'),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    /** A/R opening balance carried over from a prior system (QB import). */
    openingBalance: numeric('opening_balance', { precision: 19, scale: 4 }).notNull().default('0'),
    openingBalanceDate: date('opening_balance_date', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyAccountNumberIdx: uniqueIndex('customers_company_account_number_idx')
      .on(t.companyId, t.accountNumber)
      .where(sql`${t.accountNumber} IS NOT NULL`),
    companyDisplayNameIdx: index('customers_company_display_name_idx').on(t.companyId, t.displayName),
    companyActiveIdx: index('customers_company_active_idx').on(t.companyId, t.isActive),
  }),
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
