import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { companies, users } from './companies.js';
import { journalSourceTypeEnum } from './enums.js';

/**
 * journal_entries
 * The atomic unit of the ledger. Every economic event materialises as exactly one
 * journal_entry whose journal_lines sum to zero per currency (enforced by deferred trigger).
 *
 * Posted entries are append-only. Edits produce a reversing entry + a new entry.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    entryDate: date('entry_date', { mode: 'string' }).notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
    sourceType: journalSourceTypeEnum('source_type').notNull(),
    sourceId: uuid('source_id'),
    memo: text('memo'),
    reference: text('reference'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    reversedBy: uuid('reversed_by').references((): AnyPgColumn => journalEntries.id, {
      onDelete: 'set null',
    }),
    locked: boolean('locked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyDateIdx: index('journal_entries_company_date_idx').on(t.companyId, t.entryDate),
    companySourceIdx: index('journal_entries_company_source_idx').on(
      t.companyId,
      t.sourceType,
      t.sourceId,
    ),
    reversedByIdx: index('journal_entries_reversed_by_idx').on(t.reversedBy),
  }),
);

/**
 * journal_lines
 * One side of a journal entry. Either debit > 0 OR credit > 0, never both.
 *
 * Postgres NUMERIC(19,4) — 15 digits before the decimal, 4 after.
 * That's enough for ~$10^15 transactions; we never use float types for money.
 *
 * The DEFERRABLE INITIALLY DEFERRED constraint trigger in 0001_init_rls.sql
 * enforces that SUM(debit) = SUM(credit) per (entry_id, currency) at COMMIT.
 */
export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    debit: numeric('debit', { precision: 19, scale: 4 }).notNull().default('0'),
    credit: numeric('credit', { precision: 19, scale: 4 }).notNull().default('0'),
    currency: text('currency').notNull().default('USD'),
    fxRate: numeric('fx_rate', { precision: 19, scale: 8 }).notNull().default('1'),
    memo: text('memo'),
    /** dimension_json holds class/department/job/customer/vendor cross-references. */
    dimensionJson: jsonb('dimension_json').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entryIdx: index('journal_lines_entry_idx').on(t.entryId),
    accountDateIdx: index('journal_lines_account_idx').on(t.accountId),
    companyAccountIdx: index('journal_lines_company_account_idx').on(t.companyId, t.accountId),
    debitOrCredit: check(
      'journal_lines_debit_xor_credit',
      sql`(${t.debit} = 0 AND ${t.credit} > 0) OR (${t.debit} > 0 AND ${t.credit} = 0) OR (${t.debit} = 0 AND ${t.credit} = 0)`,
    ),
    nonNegative: check(
      'journal_lines_non_negative',
      sql`${t.debit} >= 0 AND ${t.credit} >= 0`,
    ),
  }),
);

export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;
export type JournalLine = typeof journalLines.$inferSelect;
export type NewJournalLine = typeof journalLines.$inferInsert;
