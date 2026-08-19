/**
 * Heuristic account-type inference for IIF transaction-only imports.
 * Slice #15 -- when a TRNS/SPL row references an account that doesn't exist
 * in the company's COA AND isn't being created from this file's !ACCNT
 * section, we guess a reasonable type/subtype from the name.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMissingAccounts,
  inferAccountType,
  parseIif,
} from '../src/modules/imports/iif.js';

const t = '\t';

describe('inferAccountType', () => {
  it('classifies bank-like names', () => {
    expect(inferAccountType('Checking')).toEqual({ type: 'asset', subtype: 'bank' });
    expect(inferAccountType('Operating Account')).toEqual({ type: 'asset', subtype: 'bank' });
    expect(inferAccountType('Savings')).toEqual({ type: 'asset', subtype: 'bank' });
    expect(inferAccountType('Petty Cash')).toEqual({ type: 'asset', subtype: 'bank' });
    expect(inferAccountType('Money Market')).toEqual({ type: 'asset', subtype: 'bank' });
  });

  it('classifies credit-card names', () => {
    expect(inferAccountType('Visa Card')).toEqual({
      type: 'liability',
      subtype: 'credit_card',
    });
    expect(inferAccountType('AMEX Business')).toEqual({
      type: 'liability',
      subtype: 'credit_card',
    });
    expect(inferAccountType('Credit Card')).toEqual({
      type: 'liability',
      subtype: 'credit_card',
    });
  });

  it('classifies A/R + A/P', () => {
    expect(inferAccountType('Accounts Receivable')).toEqual({
      type: 'asset',
      subtype: 'accounts_receivable',
    });
    expect(inferAccountType('Accounts Payable')).toEqual({
      type: 'liability',
      subtype: 'accounts_payable',
    });
  });

  it('classifies fixed assets', () => {
    expect(inferAccountType('Equipment')).toEqual({
      type: 'asset',
      subtype: 'fixed_asset',
    });
    expect(inferAccountType('Trucks and Vehicles')).toEqual({
      type: 'asset',
      subtype: 'fixed_asset',
    });
    expect(inferAccountType('Office Furniture')).toEqual({
      type: 'asset',
      subtype: 'fixed_asset',
    });
  });

  it('classifies inventory + prepaids', () => {
    expect(inferAccountType('Inventory')).toEqual({
      type: 'asset',
      subtype: 'other_current_asset',
    });
    expect(inferAccountType('Prepaid Insurance')).toEqual({
      type: 'asset',
      subtype: 'other_current_asset',
    });
    expect(inferAccountType('Undeposited Funds')).toEqual({
      type: 'asset',
      subtype: 'other_current_asset',
    });
  });

  it('classifies sales tax / payroll liabilities', () => {
    expect(inferAccountType('Sales Tax Payable')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
    expect(inferAccountType('Payroll Liabilities')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
  });

  it('classifies long-term liabilities', () => {
    expect(inferAccountType('Bank Loan')).toEqual({
      type: 'liability',
      subtype: 'long_term_liability',
    });
    expect(inferAccountType('Mortgage Payable')).toEqual({
      type: 'liability',
      subtype: 'long_term_liability',
    });
    expect(inferAccountType('Note Payable - Long-Term')).toEqual({
      type: 'liability',
      subtype: 'long_term_liability',
    });
  });

  it('classifies share capital as EQUITY, not inventory', () => {
    // The inventory rule's bare "stock" token (meant for "Stock on Hand")
    // claimed every share-capital account: a $50,000 Common Stock credit
    // landed in Other Current Assets, so total assets were overstated and
    // equity understated by the share issuance and the migrated balance sheet
    // could not tie to QuickBooks. Type is immutable after commit.
    for (const name of [
      'Common Stock',
      'Capital Stock',
      'Preferred Stock',
      'Treasury Stock',
      'Common Stock - Class A',
    ]) {
      expect({ name, ...inferAccountType(name) }).toEqual({
        name,
        type: 'equity',
        subtype: 'equity',
      });
    }
    // ...while genuine inventory keeps the asset classification.
    expect(inferAccountType('Stock on Hand')).toEqual({
      type: 'asset',
      subtype: 'other_current_asset',
    });
    expect(inferAccountType('Inventory Asset')).toEqual({
      type: 'asset',
      subtype: 'other_current_asset',
    });
  });

  it('classifies deferred/unearned revenue and customer prepayments as liabilities', () => {
    // QBD types these OCLIAB. Claimed by the income rule they went to the
    // revenue section of the P&L, overstating net income and taxable revenue
    // by the whole prepaid balance and erasing the liability from the balance
    // sheet -- unfixable afterwards, since account type cannot be edited.
    for (const name of [
      'Deferred Revenue',
      'Unearned Revenue',
      'Deferred Income',
      'Unearned Income',
      'Deferred Rent',
      'Customer Prepayments',
      'Client Prepayment',
    ]) {
      expect({ name, ...inferAccountType(name) }).toEqual({
        name,
        type: 'liability',
        subtype: 'other_current_liability',
      });
    }
    // Deferred-charge accounts that are NOT revenue must not be swept in:
    // "deferred" alone never makes something a liability. (Their existing
    // fallback classification is unchanged by this rule -- what matters here
    // is that money we owe and money we are owed don't get confused.)
    expect(inferAccountType('Deferred Tax Asset').type).not.toBe('liability');
    expect(inferAccountType('Deferred Charges').type).not.toBe('liability');
    // Expense wording still wins, so the deferred-tax P&L account stays an
    // expense instead of becoming a liability.
    expect(inferAccountType('Deferred Income Tax Expense')).toEqual({
      type: 'expense',
      subtype: 'other_expense',
    });
  });

  it('classifies a dedicated payroll BANK account as a bank account', () => {
    // A separate payroll checking account is standard for the payroll clients
    // this platform serves. Names without "checking"/"savings" fell through
    // to the payroll rule and became Other Current Liabilities: cash
    // understated, the liability section negative by the same amount, and the
    // account permanently absent from the bank-reconciliation picker (which
    // lists bank/credit-card subtypes only).
    for (const name of ['Payroll Account', 'Payroll Bank Account', 'Payroll Checking']) {
      expect({ name, ...inferAccountType(name) }).toEqual({
        name,
        type: 'asset',
        subtype: 'bank',
      });
    }
    // The payroll accounts that really ARE liabilities/expenses stay put.
    expect(inferAccountType('Payroll Liabilities')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
    expect(inferAccountType('Payroll Taxes Payable')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
    expect(inferAccountType('Payroll Service Fees')).toEqual({
      type: 'expense',
      subtype: 'expense',
    });
    expect(inferAccountType('Payroll Expenses:Wages')).toEqual({
      type: 'expense',
      subtype: 'expense',
    });
  });

  it('classifies equity + retained earnings', () => {
    expect(inferAccountType('Owner Equity')).toEqual({ type: 'equity', subtype: 'equity' });
    expect(inferAccountType('Retained Earnings')).toEqual({
      type: 'equity',
      subtype: 'retained_earnings',
    });
    expect(inferAccountType("Owner's Draw")).toEqual({ type: 'equity', subtype: 'equity' });
  });

  it('classifies revenue + other income', () => {
    expect(inferAccountType('Construction Income')).toEqual({
      type: 'revenue',
      subtype: 'income',
    });
    expect(inferAccountType('Service Revenue')).toEqual({ type: 'revenue', subtype: 'income' });
    expect(inferAccountType('Sales')).toEqual({ type: 'revenue', subtype: 'income' });
    expect(inferAccountType('Other Income')).toEqual({
      type: 'revenue',
      subtype: 'other_income',
    });
    expect(inferAccountType('Interest Income')).toEqual({
      type: 'revenue',
      subtype: 'other_income',
    });
  });

  it('classifies COGS + other expense', () => {
    expect(inferAccountType('Cost of Goods Sold')).toEqual({
      type: 'expense',
      subtype: 'cost_of_goods_sold',
    });
    expect(inferAccountType('Materials')).toEqual({
      type: 'expense',
      subtype: 'cost_of_goods_sold',
    });
    expect(inferAccountType('Interest Expense')).toEqual({
      type: 'expense',
      subtype: 'other_expense',
    });
    expect(inferAccountType('Depreciation')).toEqual({
      type: 'expense',
      subtype: 'other_expense',
    });
  });

  it('classifies accumulated depreciation/amortization as contra fixed assets, not P&L expense', () => {
    // "Accumulated Depreciation" sits on virtually every QBD balance sheet.
    // The bare "depreciation" alternative in the other-expense rule used to
    // claim it first, so the annual depreciation JE netted to zero on the
    // P&L (net income overstated) and the balance sheet lost its
    // accumulated depreciation entirely.
    expect(inferAccountType('Accumulated Depreciation')).toEqual({
      type: 'asset',
      subtype: 'fixed_asset',
    });
    expect(inferAccountType('Accumulated Amortization')).toEqual({
      type: 'asset',
      subtype: 'fixed_asset',
    });
    expect(inferAccountType('Accum. Depreciation')).toEqual({
      type: 'asset',
      subtype: 'fixed_asset',
    });
    // The expense side of the same JE stays on the P&L.
    expect(inferAccountType('Depreciation')).toEqual({
      type: 'expense',
      subtype: 'other_expense',
    });
    expect(inferAccountType('Depreciation Expense')).toEqual({
      type: 'expense',
      subtype: 'other_expense',
    });
  });

  it('keeps QBD default payroll EXPENSE accounts on the P&L', () => {
    // "Payroll Expenses" / "Payroll Tax Expense" exist on every
    // payroll-enabled QBD company file; classifying them as liabilities
    // strips wages off the P&L and parks a phantom negative liability on
    // the balance sheet.
    expect(inferAccountType('Payroll Expenses')).toEqual({
      type: 'expense',
      subtype: 'expense',
    });
    expect(inferAccountType('Payroll Expenses:Wages')).toEqual({
      type: 'expense',
      subtype: 'expense',
    });
    expect(inferAccountType('Payroll Tax Expense')).toEqual({
      type: 'expense',
      subtype: 'other_expense',
    });
    // Genuine payroll liabilities keep their classification.
    expect(inferAccountType('Payroll Liabilities')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
    expect(inferAccountType('Wages Payable')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
    expect(inferAccountType('Federal Withholding')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
  });

  it('classifies receivable-side loans as assets, not debt', () => {
    expect(inferAccountType('Loan Receivable')).toEqual({
      type: 'asset',
      subtype: 'other_current_asset',
    });
    expect(inferAccountType('Interest Receivable')).toEqual({
      type: 'asset',
      subtype: 'other_current_asset',
    });
    // Loans we OWE stay liabilities.
    expect(inferAccountType('Bank Loan')).toEqual({
      type: 'liability',
      subtype: 'long_term_liability',
    });
  });

  it('classifies deposits HELD from customers as liabilities, not assets', () => {
    // QBD's standard "Customer Deposits" / "Client Deposits" accounts are
    // Other Current Liabilities (retainers we owe back). The generic
    // deposit->asset pattern used to put them on the asset side, presenting
    // $18k of retainers as a negative current asset.
    expect(inferAccountType('Customer Deposits')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
    expect(inferAccountType('Client Deposits')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
    expect(inferAccountType('Tenant Deposits')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
    expect(inferAccountType('Deposits Held')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
    // Deposits we PAID (and Undeposited Funds) stay on the asset side.
    expect(inferAccountType('Undeposited Funds')).toEqual({
      type: 'asset',
      subtype: 'other_current_asset',
    });
    expect(inferAccountType('Deposits on Purchases')).toEqual({
      type: 'asset',
      subtype: 'other_current_asset',
    });
  });

  it('keeps expense accounts that merely mention Service/Sales/Consulting off the income statement', () => {
    // "Bank Service Charges" is a stock QuickBooks Desktop EXPENSE account --
    // essentially every company file carries one. The income rule's bare
    // "service"/"sales"/"consulting" alternatives claimed those names before
    // the COGS and expense rules could, so the P&L understated revenue AND
    // expenses by the same amount and neither figure tied to QuickBooks.
    for (const name of [
      'Bank Service Charges',
      'Service Charge',
      'Merchant Service Fees',
      'Answering Service',
      'Lawn Service',
      'Cleaning Service',
      'Janitorial Service',
      'Telephone Service',
      'Internet Service',
      'Sales Expense',
      'Sales Commissions Expense',
      'Consulting Fees',
      'Consulting Expense',
    ]) {
      expect({ name, ...inferAccountType(name) }).toEqual({
        name,
        type: 'expense',
        subtype: 'expense',
      });
    }
    // Tax-flavoured ones land on the other-expense line, still on the P&L.
    expect(inferAccountType('Sales Tax Expense')).toEqual({
      type: 'expense',
      subtype: 'other_expense',
    });
    expect(inferAccountType('Income Tax Expense')).toEqual({
      type: 'expense',
      subtype: 'other_expense',
    });
    // "Cost of Sales" is COGS, not negative revenue -- misfiling it destroys
    // gross margin for anyone who doesn't use QBD's "Cost of Goods Sold".
    expect(inferAccountType('Cost of Sales')).toEqual({
      type: 'expense',
      subtype: 'cost_of_goods_sold',
    });
    expect(inferAccountType('Cost of Revenue')).toEqual({
      type: 'expense',
      subtype: 'cost_of_goods_sold',
    });
    // Genuine income accounts are untouched.
    expect(inferAccountType('Sales')).toEqual({ type: 'revenue', subtype: 'income' });
    expect(inferAccountType('Service Revenue')).toEqual({ type: 'revenue', subtype: 'income' });
    expect(inferAccountType('Consulting Income')).toEqual({ type: 'revenue', subtype: 'income' });
    expect(inferAccountType('Fees Collected')).toEqual({ type: 'revenue', subtype: 'income' });
    // Contra-revenue stays in the income section, where QBD puts it.
    expect(inferAccountType('Sales Discounts')).toEqual({ type: 'revenue', subtype: 'income' });
  });

  it('files fee- and charge-worded REVENUE accounts as income, not expense', () => {
    // The expense guard on the income rule also vetoed names that say income
    // or revenue outright. "Late Fee Income" is on every property-management
    // chart and QBD's own stock finance-charge account is type INC, yet both
    // were auto-created as ordinary EXPENSE: a year of late fees arrives as
    // IIF negative amounts, posts as credits, and shows as a NEGATIVE expense
    // -- revenue and total expenses both understated by the same amount, so
    // neither line ties to the QuickBooks P&L (and gross receipts on the
    // return are wrong) even though net income happens to net out. PATCH
    // /ledger/accounts refuses type/subtype edits, so it cannot be fixed
    // after the commit.
    for (const name of [
      'Late Fee Income',
      'Late Fee Revenue',
      'Service Fee Income',
      'Membership Fees Income',
      'Delivery Fee Revenue',
      'Franchise Fee Income',
      'Finance Charge Income',
      'Application Fee Income',
      'Tenant Late Fee Income',
    ]) {
      expect({ name, ...inferAccountType(name) }).toEqual({
        name,
        type: 'revenue',
        subtype: 'income',
      });
    }
    // The rescue is narrow on purpose: only the unambiguous income/revenue
    // tokens qualify (not bare "sales"/"consulting", which QBD cost accounts
    // use), never against expense/cost/processing/penalty wording, and never
    // for deferred balances -- those are liabilities, not revenue.
    for (const name of [
      'Consulting Fees',
      'Merchant Service Fees',
      'Bank Service Charges',
      'Sales Tax Penalties',
      'Revenue Processing Fees',
      'Late Fee Collection Expense',
    ]) {
      expect({ name, ...inferAccountType(name) }).toEqual({
        name,
        type: 'expense',
        subtype: 'expense',
      });
    }
    expect(inferAccountType('Deferred Income Tax Expense')).toEqual({
      type: 'expense',
      subtype: 'other_expense',
    });
    expect(inferAccountType('Deferred Membership Fee Income').type).not.toBe('revenue');
  });

  it('keeps vehicle/equipment RUNNING costs on the P&L instead of capitalising them', () => {
    // "Computer and Internet Expenses" and "Auto and Truck Expenses" are
    // stock QBD expense accounts; booked as fixed assets they move operating
    // expense onto the balance sheet, so net income AND total assets are both
    // overstated by the full balance and a depreciation schedule built from
    // the fixed-asset section lists accounts holding pure expense.
    for (const name of [
      'Truck Expenses',
      'Auto and Truck Expenses',
      'Vehicle Expense',
      'Vehicle Insurance',
      'Vehicle Repairs & Maintenance',
      'Truck Fuel',
      'Equipment Rental',
      'Equipment Repairs',
      'Equipment Lease',
      'Machinery Rental',
      'Building Repairs',
      'Computer Repairs',
      'Computer and Internet Expenses',
      'Office Equipment Expense',
      'Land Improvements Expense',
      'Small Tools and Equipment',
      'Job Expenses:Equipment Rental',
    ]) {
      expect({ name, ...inferAccountType(name) }).toEqual({
        name,
        type: 'expense',
        subtype: 'expense',
      });
    }
    // The real fixed assets still capitalise.
    for (const name of [
      'Equipment',
      'Trucks and Vehicles',
      'Office Furniture',
      'Land',
      'Machinery & Equipment',
      'Computer Equipment',
    ]) {
      expect({ name, ...inferAccountType(name) }).toEqual({
        name,
        type: 'asset',
        subtype: 'fixed_asset',
      });
    }
  });

  it('keeps card-processing and payroll-service FEES on the P&L, not the balance sheet', () => {
    // A debited liability shows as a negative (contra) credit-card line on
    // the balance sheet and mis-buckets into operating cash flow, while the
    // P&L loses the expense entirely.
    for (const name of [
      'Credit Card Processing Fees',
      'Credit Card Fees',
      'Visa Merchant Fees',
      'Amex Discount Fees',
      'Payroll Service Fees',
      'Payroll Processing Fees',
      'Sales Tax Penalties',
    ]) {
      expect({ name, ...inferAccountType(name) }).toEqual({
        name,
        type: 'expense',
        subtype: 'expense',
      });
    }
    // Real card and liability accounts keep their classification.
    expect(inferAccountType('Visa Card')).toEqual({ type: 'liability', subtype: 'credit_card' });
    expect(inferAccountType('Credit Card')).toEqual({ type: 'liability', subtype: 'credit_card' });
    expect(inferAccountType('AMEX Business')).toEqual({
      type: 'liability',
      subtype: 'credit_card',
    });
    expect(inferAccountType('Sales Tax Payable')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
    expect(inferAccountType('Payroll Liabilities')).toEqual({
      type: 'liability',
      subtype: 'other_current_liability',
    });
  });

  it('treats "Charge Card" as the card LIABILITY it is, not fee wording', () => {
    // The expense guard on the card rule matched the bare "charge" token, so
    // a CCARD account named "AMEX Charge Card" fell to the expense default:
    // the outstanding card balance sits as a negative expense on the P&L
    // instead of a liability on the balance sheet, and the account never
    // appears in the reconciliation picker (bank/credit_card subtypes only),
    // so the card can never be reconciled.
    for (const name of [
      'AMEX Charge Card',
      'Amex Charge Card - 1005',
      'Visa Charge Card',
      'Mastercard Charge Account',
      'Business Charge Card',
    ]) {
      expect({ name, ...inferAccountType(name) }).toEqual({
        name,
        type: 'liability',
        subtype: 'credit_card',
      });
    }
    // Fee wording still wins once the card phrase is set aside, so merchant
    // costs stay on the P&L.
    for (const name of ['Charge Card Fees', 'Amex Charge Card Processing Fees']) {
      expect({ name, ...inferAccountType(name) }).toEqual({
        name,
        type: 'expense',
        subtype: 'expense',
      });
    }
  });

  it('defaults to ordinary expense for ambiguous names', () => {
    expect(inferAccountType('Subcontractor Expense')).toEqual({
      type: 'expense',
      subtype: 'expense',
    });
    expect(inferAccountType('Office Supplies')).toEqual({
      type: 'expense',
      subtype: 'expense',
    });
    expect(inferAccountType('Random Vendor Charge')).toEqual({
      type: 'expense',
      subtype: 'expense',
    });
  });
});

describe('buildMissingAccounts', () => {
  it('finds account names referenced by TRNS/SPL but not in DB or !ACCNT', () => {
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE`,
      `ACCNT${t}Office Expense${t}EXP`, // included in file -> not "missing"
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      // INVOICE -> Construction Income, Accounts Receivable
      `TRNS${t}INVOICE${t}2026-01-15${t}Accounts Receivable${t}500.00`,
      `SPL${t}INVOICE${t}2026-01-15${t}Construction Income${t}-500.00`,
      `ENDTRNS`,
      // CHECK -> Checking, Office Expense (exists in file)
      `TRNS${t}CHECK${t}2026-01-16${t}Checking${t}-50.00`,
      `SPL${t}CHECK${t}2026-01-16${t}Office Expense${t}50.00`,
      `ENDTRNS`,
    ].join('\n');
    const preview = parseIif(text);
    const existing = new Set<string>(); // empty DB
    const missing = buildMissingAccounts(preview, existing);
    const names = missing.map((m) => m.name).sort();
    // Office Expense is in !ACCNT, so not missing.
    expect(names).toEqual(['Accounts Receivable', 'Checking', 'Construction Income']);

    const checking = missing.find((m) => m.name === 'Checking')!;
    expect(checking.suggestedType).toBe('asset');
    expect(checking.suggestedSubtype).toBe('bank');

    const ar = missing.find((m) => m.name === 'Accounts Receivable')!;
    expect(ar.suggestedSubtype).toBe('accounts_receivable');

    const income = missing.find((m) => m.name === 'Construction Income')!;
    expect(income.suggestedType).toBe('revenue');
    expect(income.suggestedSubtype).toBe('income');
  });

  it('respects existing-DB names (case-insensitive)', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}INVOICE${t}2026-01-15${t}AR${t}1.00`,
      `SPL${t}INVOICE${t}2026-01-15${t}sales${t}-1.00`,
      `ENDTRNS`,
    ].join('\n');
    const preview = parseIif(text);
    const existing = new Set(['ar', 'Sales']); // mixed case in DB
    const missing = buildMissingAccounts(preview, existing);
    expect(missing.map((m) => m.name)).toEqual([]);
  });

  it('counts occurrences across multiple TRNS/SPL blocks', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}2026-01-01${t}Checking${t}-10.00`,
      `SPL${t}CHECK${t}2026-01-01${t}Office Expense${t}10.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}2026-01-02${t}Checking${t}-20.00`,
      `SPL${t}CHECK${t}2026-01-02${t}Office Expense${t}20.00`,
      `ENDTRNS`,
      `TRNS${t}DEPOSIT${t}2026-01-03${t}Checking${t}100.00`,
      `SPL${t}DEPOSIT${t}2026-01-03${t}Sales${t}-100.00`,
      `ENDTRNS`,
    ].join('\n');
    const preview = parseIif(text);
    const missing = buildMissingAccounts(preview, new Set());
    const checking = missing.find((m) => m.name === 'Checking')!;
    expect(checking.occurrences).toBe(3); // 3 TRNS rows
    const office = missing.find((m) => m.name === 'Office Expense')!;
    expect(office.occurrences).toBe(2);
    const sales = missing.find((m) => m.name === 'Sales')!;
    expect(sales.occurrences).toBe(1);
  });

  it('suggests EXPENSE for stock QBD expense accounts a transactions-only file auto-creates', () => {
    // The transactions-first path is where the heuristic actually reaches the
    // customer: every row in the preview's "accounts to create" table is
    // pre-ticked with the suggested type, so a wrong guess commits by
    // default. These three names are QBD chart-of-accounts defaults.
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}3/4/2026${t}Checking${t}-32.00`,
      `SPL${t}CHECK${t}3/4/2026${t}Bank Service Charges${t}32.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}3/5/2026${t}Checking${t}-1200.00`,
      `SPL${t}CHECK${t}3/5/2026${t}Equipment Rental${t}1200.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}3/6/2026${t}Checking${t}-450.00`,
      `SPL${t}CHECK${t}3/6/2026${t}Auto and Truck Expenses${t}450.00`,
      `ENDTRNS`,
    ].join('\r\n');
    const preview = parseIif(text);
    const missing = buildMissingAccounts(preview, new Set());
    for (const name of ['Bank Service Charges', 'Equipment Rental', 'Auto and Truck Expenses']) {
      const row = missing.find((m) => m.name === name)!;
      expect({ name, type: row.suggestedType, subtype: row.suggestedSubtype }).toEqual({
        name,
        type: 'expense',
        subtype: 'expense',
      });
      expect(parseInt(row.suggestedCode, 10)).toBeGreaterThanOrEqual(5000);
    }
  });

  it('suggests the right SIDE OF THE BALANCE SHEET for share capital, deferred revenue and a payroll bank', () => {
    // The transactions-only path is where these three actually reach the
    // customer: every missing-account row is pre-ticked with the suggested
    // type, so a wrong guess commits by default and cannot be corrected
    // afterwards (type/subtype are immutable once an account exists).
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}DEPOSIT${t}3/4/2026${t}Checking${t}50,000.00`,
      `SPL${t}DEPOSIT${t}3/4/2026${t}Common Stock${t}-50,000.00`,
      `ENDTRNS`,
      `TRNS${t}DEPOSIT${t}3/5/2026${t}Checking${t}80,000.00`,
      `SPL${t}DEPOSIT${t}3/5/2026${t}Deferred Revenue${t}-80,000.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}3/6/2026${t}Payroll Account${t}-3,200.00`,
      `SPL${t}CHECK${t}3/6/2026${t}Payroll Expenses${t}3,200.00`,
      `ENDTRNS`,
    ].join('\r\n');
    const preview = parseIif(text);
    const missing = buildMissingAccounts(preview, new Set());
    const suggested = (name: string) => {
      const row = missing.find((m) => m.name === name)!;
      return { name, type: row.suggestedType, subtype: row.suggestedSubtype };
    };
    expect(suggested('Common Stock')).toEqual({
      name: 'Common Stock',
      type: 'equity',
      subtype: 'equity',
    });
    expect(suggested('Deferred Revenue')).toEqual({
      name: 'Deferred Revenue',
      type: 'liability',
      subtype: 'other_current_liability',
    });
    expect(suggested('Payroll Account')).toEqual({
      name: 'Payroll Account',
      type: 'asset',
      subtype: 'bank',
    });
  });

  it('assigns codes within the right ranges per type', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}INVOICE${t}2026-01-15${t}Cash${t}500.00`,
      `SPL${t}INVOICE${t}2026-01-15${t}Sales${t}-500.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}2026-01-16${t}Checking${t}-50.00`,
      `SPL${t}CHECK${t}2026-01-16${t}Office Supplies${t}50.00`,
      `ENDTRNS`,
    ].join('\n');
    const preview = parseIif(text);
    const missing = buildMissingAccounts(preview, new Set());
    for (const m of missing) {
      const code = parseInt(m.suggestedCode, 10);
      if (m.suggestedType === 'asset') expect(code).toBeGreaterThanOrEqual(1000);
      if (m.suggestedType === 'asset') expect(code).toBeLessThan(2000);
      if (m.suggestedType === 'revenue') expect(code).toBeGreaterThanOrEqual(4000);
      if (m.suggestedType === 'revenue') expect(code).toBeLessThan(5000);
      if (m.suggestedType === 'expense') expect(code).toBeGreaterThanOrEqual(5000);
      if (m.suggestedType === 'expense') expect(code).toBeLessThan(6000);
    }
  });
});
