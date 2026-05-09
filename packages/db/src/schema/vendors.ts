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
import { accounts } from './accounts';
import { companies } from './companies';
import {
  payRateBasisEnum,
  payScheduleEnum,
  payrollFilingStatusEnum,
  workerTypeEnum,
} from './enums';

/**
 * vendors
 * One row per vendor (supplier) of a company. Used as the counterparty on
 * bills and outgoing payments. The `is_1099_vendor` flag drives 1099 prep
 * at year-end; `tax_id` holds the TIN/EIN we'll need on the form.
 */
export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    companyName: text('company_name'),
    /** Client-assigned vendor number, e.g. "V-203". Optional but unique within a company when set. */
    accountNumber: text('account_number'),
    email: text('email'),
    phone: text('phone'),
    /** { street1, street2, city, state, postalCode, country } */
    mailingAddress: jsonb('mailing_address').$type<Record<string, unknown>>(),
    /** Default payment terms in days. Null = "Due on receipt". */
    defaultTermsDays: smallint('default_terms_days'),
    /** Mark vendors that should receive a 1099-NEC at year-end. */
    is1099Vendor: boolean('is_1099_vendor').notNull().default(false),
    /** TIN or EIN — required if is_1099_vendor is true. */
    taxId: text('tax_id'),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    /** A/P opening balance carried over from a prior system (QB import). */
    openingBalance: numeric('opening_balance', { precision: 19, scale: 4 }).notNull().default('0'),
    openingBalanceDate: date('opening_balance_date', { mode: 'string' }),
    // ---- Worker fields (added in slice #25) -----------------------------
    /**
     * Whether this vendor is a worker we track in the Workers tab.
     * 'contractor' surfaces in 1099 prep when is_1099_vendor is also set.
     * 'employee' is informational only -- ACH payroll is intentionally not
     * built per the office workflow (printed checks, picked up in person).
     */
    workerType: workerTypeEnum('worker_type').notNull().default('not_a_worker'),
    /** Job title or role, e.g. "Lead carpenter" or "Bookkeeper". */
    title: text('title'),
    hireDate: date('hire_date', { mode: 'string' }),
    terminationDate: date('termination_date', { mode: 'string' }),
    /** Display-only pay rate; we don't compute paychecks from this. */
    payRate: numeric('pay_rate', { precision: 19, scale: 4 }),
    payRateBasis: payRateBasisEnum('pay_rate_basis'),
    /** Default expense GL account when paying this worker (e.g. "Contract Labor"). */
    defaultExpenseAccountId: uuid('default_expense_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    workersCompClass: text('workers_comp_class'),
    // ---- W-2 employee tracking (display only -- KPBooks doesn't compute taxes)
    /** W-4 filing status. Required for proper W-2 prep at year end. */
    w2FilingStatus: payrollFilingStatusEnum('w2_filing_status'),
    /** Legacy W-4 (pre-2020). Modern W-4 uses dependents/deductions instead but
     *  many bookkeepers still record allowances here. */
    w2Allowances: smallint('w2_allowances'),
    /** Modern W-4 (2020+) Box 4c -- additional federal withholding per check. */
    w2AdditionalWithholding: numeric('w2_additional_withholding', { precision: 19, scale: 4 }),
    /** State for state-tax-withholding purposes (e.g. "TX", "CA"). */
    w2State: text('w2_state'),
    /** How often the worker is paid. Distinct from payRateBasis (which describes
     *  what the rate means). A worker can be paid $25/hr (pay_rate_basis=hourly)
     *  on a biweekly check schedule (pay_schedule=biweekly). */
    paySchedule: payScheduleEnum('pay_schedule'),
    // ---- Subcontractor compliance (construction industry)
    licenseNumber: text('license_number'),
    licenseState: text('license_state'),
    licenseExpiration: date('license_expiration', { mode: 'string' }),
    insuranceGeneralLiabilityCarrier: text('insurance_general_liability_carrier'),
    insuranceGeneralLiabilityPolicyNumber: text('insurance_general_liability_policy_number'),
    insuranceGeneralLiabilityExpiration: date('insurance_general_liability_expiration', {
      mode: 'string',
    }),
    insuranceWorkersCompCarrier: text('insurance_workers_comp_carrier'),
    insuranceWorkersCompPolicyNumber: text('insurance_workers_comp_policy_number'),
    insuranceWorkersCompExpiration: date('insurance_workers_comp_expiration', { mode: 'string' }),
    /** When true, the bookkeeper expects a lien-waiver signed by this sub
     *  on every payment. Drives a "missing lien waiver" warning on payments. */
    lienWaiverRequired: boolean('lien_waiver_required').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyAccountNumberIdx: uniqueIndex('vendors_company_account_number_idx')
      .on(t.companyId, t.accountNumber)
      .where(sql`${t.accountNumber} IS NOT NULL`),
    companyDisplayNameIdx: index('vendors_company_display_name_idx').on(t.companyId, t.displayName),
    companyActiveIdx: index('vendors_company_active_idx').on(t.companyId, t.isActive),
    companyWorkerTypeIdx: index('vendors_company_worker_type_idx').on(t.companyId, t.workerType),
  }),
);

export type Vendor = typeof vendors.$inferSelect;
export type NewVendor = typeof vendors.$inferInsert;
