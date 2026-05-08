/**
 * Default chart of accounts seeded into a newly created company.
 *
 * Codes follow the conventional 1xxx (assets) → 6xxx (expenses) blocks.
 * Subtypes drive the report grouping in trial-balance and P&L queries.
 *
 * This list is deliberately compact — most small businesses live happily with
 * ~25 accounts and add more as they grow. Seeding too many accounts up front
 * just creates noise in screens.
 */

export interface DefaultAccount {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype:
    | 'bank'
    | 'accounts_receivable'
    | 'other_current_asset'
    | 'fixed_asset'
    | 'other_asset'
    | 'accounts_payable'
    | 'credit_card'
    | 'other_current_liability'
    | 'long_term_liability'
    | 'equity'
    | 'retained_earnings'
    | 'income'
    | 'other_income'
    | 'expense'
    | 'cost_of_goods_sold'
    | 'other_expense';
}

export const DEFAULT_COA: DefaultAccount[] = [
  // Assets
  { code: '1000', name: 'Cash on Hand', type: 'asset', subtype: 'bank' },
  { code: '1010', name: 'Checking Account', type: 'asset', subtype: 'bank' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
  { code: '1200', name: 'Inventory', type: 'asset', subtype: 'other_current_asset' },
  { code: '1500', name: 'Equipment', type: 'asset', subtype: 'fixed_asset' },

  // Liabilities
  { code: '2000', name: 'Accounts Payable', type: 'liability', subtype: 'accounts_payable' },
  { code: '2100', name: 'Credit Card', type: 'liability', subtype: 'credit_card' },
  {
    code: '2200',
    name: 'Sales Tax Payable',
    type: 'liability',
    subtype: 'other_current_liability',
  },
  {
    code: '2300',
    name: 'Payroll Liabilities',
    type: 'liability',
    subtype: 'other_current_liability',
  },
  { code: '2500', name: 'Loans Payable', type: 'liability', subtype: 'long_term_liability' },

  // Equity
  { code: '3000', name: "Owner's Equity", type: 'equity', subtype: 'equity' },
  { code: '3900', name: 'Retained Earnings', type: 'equity', subtype: 'retained_earnings' },

  // Revenue
  { code: '4000', name: 'Sales', type: 'revenue', subtype: 'income' },
  { code: '4100', name: 'Service Income', type: 'revenue', subtype: 'income' },
  { code: '4900', name: 'Other Income', type: 'revenue', subtype: 'other_income' },

  // Expenses
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', subtype: 'cost_of_goods_sold' },
  { code: '6000', name: 'Office Expense', type: 'expense', subtype: 'expense' },
  { code: '6100', name: 'Rent', type: 'expense', subtype: 'expense' },
  { code: '6200', name: 'Utilities', type: 'expense', subtype: 'expense' },
  { code: '6300', name: 'Wages', type: 'expense', subtype: 'expense' },
  { code: '6400', name: 'Travel', type: 'expense', subtype: 'expense' },
  { code: '6500', name: 'Meals & Entertainment', type: 'expense', subtype: 'expense' },
  { code: '6600', name: 'Insurance', type: 'expense', subtype: 'expense' },
  { code: '6700', name: 'Professional Services', type: 'expense', subtype: 'expense' },
  { code: '6800', name: 'Bank Fees', type: 'expense', subtype: 'expense' },
  { code: '6900', name: 'Other Expense', type: 'expense', subtype: 'other_expense' },
];
