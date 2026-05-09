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

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'open',
  'partial',
  'paid',
  'void',
]);

export const estimateStatusEnum = pgEnum('estimate_status', [
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'converted',
]);

export const billStatusEnum = pgEnum('bill_status', [
  'open',
  'partial',
  'paid',
  'void',
]);

export const paymentTypeEnum = pgEnum('payment_type', [
  'customer_received',
  'vendor_sent',
]);

export const paymentMethodEnum = pgEnum('payment_method', [
  'check',
  'cash',
  'eft',
  'credit_card',
  'other',
]);

export const paymentStatusEnum = pgEnum('payment_status', ['posted', 'void']);

export const bankTransactionStatusEnum = pgEnum('bank_transaction_status', [
  'unmatched', // imported, no AI suggestion yet
  'suggested', // AI categorized; awaiting user review
  'posted', // user confirmed; journal_entry written
  'ignored', // user marked irrelevant
]);

export const aiConfidenceEnum = pgEnum('ai_confidence', ['high', 'medium', 'low']);

export const reconciliationStatusEnum = pgEnum('reconciliation_status', [
  'in_progress',
  'completed',
]);

export const workerTypeEnum = pgEnum('worker_type', [
  'contractor',
  'employee',
  'not_a_worker',
  'subcontractor',
]);

export const payrollFilingStatusEnum = pgEnum('payroll_filing_status', [
  'single',
  'married_jointly',
  'married_separately',
  'head_of_household',
  'qualifying_widow',
]);

export const payScheduleEnum = pgEnum('pay_schedule', [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
]);

export const payrollRunStatusEnum = pgEnum('payroll_run_status', [
  'draft',
  'posted',
  'voided',
]);

export const payRateBasisEnum = pgEnum('pay_rate_basis', [
  'hourly',
  'weekly',
  'biweekly',
  'monthly',
  'annually',
  'project',
]);

export const recurringTemplateKindEnum = pgEnum('recurring_template_kind', [
  'invoice',
  'bill',
]);

export const recurringFrequencyEnum = pgEnum('recurring_frequency', [
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'annually',
]);

export const itemTypeEnum = pgEnum('item_type', ['service', 'non_inventory']);
