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
import { companies, users } from './companies';
import {
  payScheduleEnum,
  payrollRunStatusEnum,
  workerTypeEnum,
} from './enums';
import { payments } from './payments';
import { vendors } from './vendors';

/**
 * payroll_runs
 *
 * A batch of paychecks for one pay period. Tracking-only: KPBooks does
 * NOT compute taxes -- the bookkeeper enters gross, withholdings, and
 * net per row. On post, each line writes ONE vendor_sent payment at NET
 * via the existing payments posting service. Gross + deductions are
 * stored on the line so the pay-stub PDF (slice #30) can render a
 * full statement-of-earnings.
 *
 * State machine:
 *   draft   -> bookkeeper edits lines
 *   posted  -> N payments written; lines locked (DB trigger 0033)
 *   voided  -> linked payments voided; run preserved for audit
 */
export const payrollRuns = pgTable(
  'payroll_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    payDate: date('pay_date', { mode: 'string' }).notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    /** If set, used by the eligibility query to scope lines to one schedule. */
    paySchedule: payScheduleEnum('pay_schedule'),
    /** If set, used by the eligibility query to scope lines to one classification. */
    workerTypeFilter: workerTypeEnum('worker_type_filter'),
    /** Bank/CC account checks are drawn from. Required at post time but
     *  nullable so drafts can save without committing to one yet. */
    bankAccountId: uuid('bank_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    status: payrollRunStatusEnum('status').notNull().default('draft'),
    memo: text('memo'),
    totalGross: numeric('total_gross', { precision: 19, scale: 4 }).notNull().default('0'),
    totalNet: numeric('total_net', { precision: 19, scale: 4 }).notNull().default('0'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyPayDateIdx: index('payroll_runs_company_pay_date_idx').on(
      t.companyId,
      t.payDate,
    ),
    companyStatusIdx: index('payroll_runs_company_status_idx').on(t.companyId, t.status),
    periodOrder: check('payroll_runs_period_order', sql`${t.periodEnd} >= ${t.periodStart}`),
    payAfterStart: check(
      'payroll_runs_pay_after_start',
      sql`${t.payDate} >= ${t.periodStart}`,
    ),
    amountsNonNegative: check(
      'payroll_runs_amounts_non_negative',
      sql`${t.totalGross} >= 0 AND ${t.totalNet} >= 0`,
    ),
    postedConsistency: check(
      'payroll_runs_posted_consistency',
      sql`(${t.status} = 'posted') = (${t.postedAt} IS NOT NULL)`,
    ),
    voidedConsistency: check(
      'payroll_runs_voided_consistency',
      sql`(${t.status} = 'voided') = (${t.voidedAt} IS NOT NULL)`,
    ),
  }),
);

export const payrollRunLines = pgTable(
  'payroll_run_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payrollRunId: uuid('payroll_run_id')
      .notNull()
      .references(() => payrollRuns.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    /** Snapshot at line-creation; reclassification later doesn't rewrite history. */
    workerTypeAtCreation: workerTypeEnum('worker_type_at_creation'),
    /** Optional hours for hourly workers; nullable for fixed-rate / project workers. */
    hours: numeric('hours', { precision: 10, scale: 4 }),
    /** Optional rate. Display only; not used to compute gross at post time. */
    rate: numeric('rate', { precision: 19, scale: 4 }),
    gross: numeric('gross', { precision: 19, scale: 4 }).notNull(),
    federalIncomeTax: numeric('federal_income_tax', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    socialSecurity: numeric('social_security', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    medicare: numeric('medicare', { precision: 19, scale: 4 }).notNull().default('0'),
    stateIncomeTax: numeric('state_income_tax', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    otherDeductions: numeric('other_deductions', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    net: numeric('net', { precision: 19, scale: 4 }).notNull(),
    memo: text('memo'),
    /** FK to the payment row this line wrote on post. Set to null on void. */
    postedPaymentId: uuid('posted_payment_id').references(() => payments.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('payroll_run_lines_run_idx').on(t.payrollRunId),
    companyVendorIdx: index('payroll_run_lines_company_vendor_idx').on(
      t.companyId,
      t.vendorId,
    ),
    amountsNonNegative: check(
      'payroll_run_lines_amounts_non_negative',
      sql`${t.gross} >= 0 AND ${t.federalIncomeTax} >= 0 AND ${t.socialSecurity} >= 0
        AND ${t.medicare} >= 0 AND ${t.stateIncomeTax} >= 0
        AND ${t.otherDeductions} >= 0 AND ${t.net} >= 0`,
    ),
  }),
);

export type PayrollRun = typeof payrollRuns.$inferSelect;
export type NewPayrollRun = typeof payrollRuns.$inferInsert;
export type PayrollRunLine = typeof payrollRunLines.$inferSelect;
export type NewPayrollRunLine = typeof payrollRunLines.$inferInsert;
