import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { companies, users } from './companies';
import { reconciliationStatusEnum } from './enums';

/**
 * reconciliations
 * One per bank-statement reconciliation. The CPA workflow:
 *   1. Receive monthly statement from the bank.
 *   2. Start a reconciliation: pick the bank account, enter the statement
 *      date + ending balance.
 *   3. Walk the list of posted bank_transactions; mark each as cleared if
 *      it appears on the statement.
 *   4. When sum(cleared) == statementBalance - prevReconciledBalance, the
 *      reconciliation is balanced and can be finalised.
 *   5. After finalise, the cleared rows are locked to this reconciliation.
 *
 * For v1 we don't carry a beginningBalance forward automatically -- the user
 * either has zero prior reconciliations (start from $0) or the prev one
 * holds the running balance.
 */
export const reconciliations = pgTable(
  'reconciliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    statementDate: date('statement_date', { mode: 'string' }).notNull(),
    /** Ending balance from the bank statement. */
    statementBalance: numeric('statement_balance', { precision: 19, scale: 4 }).notNull(),
    /**
     * Beginning balance carried in from the previous reconciliation
     * (or 0 for the first one). Used so the diff math is
     * sum(cleared.amount) == statementBalance - beginningBalance.
     */
    beginningBalance: numeric('beginning_balance', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    status: reconciliationStatusEnum('status').notNull().default('in_progress'),
    notes: text('notes'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyAccountIdx: index('reconciliations_company_account_idx').on(
      t.companyId,
      t.bankAccountId,
    ),
    companyDateIdx: index('reconciliations_company_date_idx').on(t.companyId, t.statementDate),
    /** Only one in-progress reconciliation per bank account at a time. */
    oneInProgressIdx: uniqueIndex('reconciliations_one_in_progress_idx')
      .on(t.bankAccountId)
      .where(sql`${t.status} = 'in_progress'`),
    completedConsistency: check(
      'reconciliations_completed_consistency',
      sql`(${t.status} = 'completed') = (${t.completedAt} IS NOT NULL)`,
    ),
  }),
);

export type Reconciliation = typeof reconciliations.$inferSelect;
export type NewReconciliation = typeof reconciliations.$inferInsert;
