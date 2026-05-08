import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { companies } from './companies';

/**
 * bank_rules
 * User-defined patterns that auto-categorize bank transactions on CSV import,
 * before falling back to AI. The matcher is run at import time: the first
 * active rule (by ascending priority) whose pattern matches the description
 * AND amount-sign filter wins, and pre-fills suggestedAccountId on the
 * bank_transactions row with confidence='high'.
 *
 * Scope:
 *   - bankAccountId NULL = match against any imported bank account
 *   - bankAccountId set  = only match imports from that specific account
 *
 * matchType options:
 *   - contains   (default; case-insensitive substring of description)
 *   - starts_with / ends_with (case-insensitive)
 *   - exact      (case-insensitive full-string equality, after trim)
 *   - regex      (POSIX regex, runs through Postgres ~)
 *
 * amountSign filter:
 *   - any        (default)
 *   - positive   (deposit-only rules: e.g. "anything from Stripe -> Sales")
 *   - negative   (withdrawal-only rules: e.g. "anything to Verizon -> Telephone")
 *
 * hitCount + lastHitAt let the UI show "this rule fired 47 times, last on
 * 2026-04-30" so the user can spot stale rules.
 */
export const bankRules = pgTable(
  'bank_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** NULL = applies to all bank accounts; set = scoped to one account. */
    bankAccountId: uuid('bank_account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    /** Human-readable label (defaults to the match value). */
    name: text('name').notNull(),
    matchType: text('match_type').notNull().default('contains'),
    matchValue: text('match_value').notNull(),
    amountSign: text('amount_sign').notNull().default('any'),
    /** The account the matched bank line gets categorized to. */
    targetAccountId: uuid('target_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    /** Optional memo override; null = use the bank line's description. */
    memoTemplate: text('memo_template'),
    /** Lower runs first; ties broken by createdAt asc. */
    priority: integer('priority').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    /** Number of bank lines this rule has matched, lifetime. */
    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyActiveIdx: index('bank_rules_company_active_idx').on(t.companyId, t.isActive, t.priority),
    companyAccountIdx: index('bank_rules_company_account_idx').on(t.companyId, t.bankAccountId),
    matchTypeCheck: check(
      'bank_rules_match_type_chk',
      sql`${t.matchType} IN ('contains','starts_with','ends_with','exact','regex')`,
    ),
    amountSignCheck: check(
      'bank_rules_amount_sign_chk',
      sql`${t.amountSign} IN ('any','positive','negative')`,
    ),
    matchValueLength: check(
      'bank_rules_match_value_length',
      sql`length(${t.matchValue}) >= 1 AND length(${t.matchValue}) <= 500`,
    ),
  }),
);

export type BankRule = typeof bankRules.$inferSelect;
export type NewBankRule = typeof bankRules.$inferInsert;
