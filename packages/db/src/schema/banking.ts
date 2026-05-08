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
import { aiConfidenceEnum, bankTransactionStatusEnum } from './enums';
import { companies } from './companies';
import { journalEntries } from './ledger';
import { reconciliations } from './reconciliations';

/**
 * bank_transactions
 * Staging table for CSV-imported bank lines. The flow is:
 *   1. Import CSV  -> rows land here with status='unmatched'.
 *   2. AI categorize -> sets suggestedAccountId, status='suggested'.
 *   3. User confirms -> creates a journal_entry, sets postedJournalEntryId,
 *                       status='posted'.
 *   4. Or user ignores -> status='ignored', no JE.
 *
 * Sign convention: amount > 0 = deposit (DR bank), amount < 0 = withdrawal
 * (CR bank). The other side of the JE is whichever account the user picks.
 *
 * Lock-after-post: once status='posted', the row is immutable except for the
 * status -> 'void'... no wait, voiding is done by voiding the JE itself.
 * For now, posted rows are fully immutable.
 */
export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** The bank/credit-card account this CSV came from. */
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    transactionDate: date('transaction_date', { mode: 'string' }).notNull(),
    description: text('description').notNull(),
    /** Signed: positive = deposit (DR bank), negative = withdrawal (CR bank). */
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    /** Running balance from the CSV if the bank exports it. Display only. */
    balance: numeric('balance', { precision: 19, scale: 4 }),
    status: bankTransactionStatusEnum('status').notNull().default('unmatched'),
    /** Account picked by the AI (or null if unmatched). User can override. */
    suggestedAccountId: uuid('suggested_account_id').references(
      () => accounts.id,
      { onDelete: 'set null' },
    ),
    suggestedConfidence: aiConfidenceEnum('suggested_confidence'),
    /** Short AI explanation shown to the user during review. */
    suggestedReason: text('suggested_reason'),
    /** Set when the user confirms; links the JE created from this row. */
    postedJournalEntryId: uuid('posted_journal_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'restrict' },
    ),
    /**
     * Groups all rows from a single CSV upload so the user can see
     * "Imported 142 transactions on 2026-05-08".
     */
    importBatchId: uuid('import_batch_id').notNull(),
    /** Original CSV line for debugging / auditing. */
    rawCsvLine: text('raw_csv_line'),
    /**
     * SHA-256 of (bank_account_id, transaction_date, description, amount).
     * Used to detect duplicate imports (re-uploading the same statement).
     */
    dedupeHash: text('dedupe_hash').notNull(),
    /** When the user marked this txn as cleared on a statement. */
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    /** Reconciliation this txn was cleared into; finalised reconciliations lock the row. */
    reconciliationId: uuid('reconciliation_id').references(() => reconciliations.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyAccountIdx: index('bank_transactions_company_account_idx').on(t.companyId, t.bankAccountId),
    companyStatusIdx: index('bank_transactions_company_status_idx').on(t.companyId, t.status),
    companyDateIdx: index('bank_transactions_company_date_idx').on(t.companyId, t.transactionDate),
    importBatchIdx: index('bank_transactions_import_batch_idx').on(t.importBatchId),
    reconciliationIdx: index('bank_transactions_reconciliation_idx').on(t.reconciliationId),
    /** Dedup at the DB layer so a re-uploaded statement doesn't double-post. */
    companyDedupeIdx: index('bank_transactions_company_dedupe_idx').on(t.companyId, t.dedupeHash),
    nonZeroAmount: check('bank_transactions_nonzero_amount', sql`${t.amount} <> 0`),
    postedConsistency: check(
      'bank_transactions_posted_consistency',
      sql`(${t.status} = 'posted') = (${t.postedJournalEntryId} IS NOT NULL)`,
    ),
    /** A row can only be cleared if it's posted -- can't reconcile an unposted txn. */
    clearedRequiresPosted: check(
      'bank_transactions_cleared_requires_posted',
      sql`(${t.clearedAt} IS NULL) OR (${t.status} = 'posted')`,
    ),
    /** clearedAt and reconciliationId rise + fall together. */
    clearedReconConsistency: check(
      'bank_transactions_cleared_recon_consistency',
      sql`(${t.clearedAt} IS NULL) = (${t.reconciliationId} IS NULL)`,
    ),
  }),
);

export type BankTransaction = typeof bankTransactions.$inferSelect;
export type NewBankTransaction = typeof bankTransactions.$inferInsert;
