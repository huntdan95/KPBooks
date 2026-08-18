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
