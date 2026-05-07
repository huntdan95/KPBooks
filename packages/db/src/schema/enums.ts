import { pgEnum } from 'drizzle-orm/pg-core';

export const accountTypeEnum = pgEnum('account_type', [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
]);

export const accountSubtypeEnum = pgEnum('account_subtype', [
  // assets
  'bank',
  'accounts_receivable',
  'other_current_asset',
  'fixed_asset',
  'other_asset',
  // liabilities
  'accounts_payable',
  'credit_card',
  'other_current_liability',
  'long_term_liability',
  // equity
  'equity',
  'retained_earnings',
  // revenue
  'income',
  'other_income',
  // expense
  'expense',
  'cost_of_goods_sold',
  'other_expense',
]);

export const membershipRoleEnum = pgEnum('membership_role', [
  'owner',
  'admin',
  'bookkeeper',
  'viewer',
]);

export const journalSourceTypeEnum = pgEnum('journal_source_type', [
  'manual',
  'invoice',
  'bill',
  'payment',
  'bank_transaction',
  'reconciliation',
  'payroll',
  'import',
  'reversal',
]);
