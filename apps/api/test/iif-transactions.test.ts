/**
 * IIF transaction parser: TRNSTYPE coverage, sign convention, date/number
 * normalisation, multi-block files, error handling on malformed blocks.
 *
 * Commit logic is tested via integration in packages/db once we have the
 * test harness that posts journal_entries; for now this file focuses on the
 * parser, which is the algorithmic core.
 */
import { describe, expect, it } from 'vitest';
import { normaliseAmount, normaliseDate, parseIif } from '../src/modules/imports/iif.js';

const t = '\t';

describe('normaliseDate', () => {
  it('passes through ISO YYYY-MM-DD', () => {
    expect(normaliseDate('2026-01-15')).toBe('2026-01-15');
  });
  it('normalises MM/DD/YYYY', () => {
    expect(normaliseDate('01/15/2026')).toBe('2026-01-15');
    expect(normaliseDate('1/5/2026')).toBe('2026-01-05');
  });
  it('expands two-digit years 00-49 -> 2000s, 50-99 -> 1900s', () => {
    expect(normaliseDate('01/15/26')).toBe('2026-01-15');
    expect(normaliseDate('01/15/49')).toBe('2049-01-15');
    expect(normaliseDate('01/15/50')).toBe('1950-01-15');
    expect(normaliseDate('01/15/99')).toBe('1999-01-15');
  });
  it('rejects garbage', () => {
    expect(normaliseDate('')).toBeNull();
    expect(normaliseDate('not a date')).toBeNull();
    expect(normaliseDate('13/15/2026')).toBeNull();
  });
});

describe('normaliseAmount', () => {
  it('canonicalises plain decimals to 4dp', () => {
    expect(normaliseAmount('250')).toBe('250.0000');
    expect(normaliseAmount('250.5')).toBe('250.5000');
    expect(normaliseAmount('250.50')).toBe('250.5000');
  });
  it('strips $ and thousands commas', () => {
    expect(normaliseAmount('$1,234.56')).toBe('1234.5600');
    expect(normaliseAmount('  $ 1,234.56 ')).toBe('1234.5600');
  });
  it('handles signed and parens negatives', () => {
    expect(normaliseAmount('-250.00')).toBe('-250.0000');
    expect(normaliseAmount('+250.00')).toBe('250.0000');
    expect(normaliseAmount('(250.00)')).toBe('-250.0000');
  });
  it('truncates beyond 4 decimal places', () => {
    expect(normaliseAmount('1.23456789')).toBe('1.2345');
  });
  it('rejects garbage', () => {
    expect(normaliseAmount('')).toBeNull();
    expect(normaliseAmount('not a number')).toBeNull();
  });
});

describe('parseIif transactions', () => {
  it('parses an INVOICE block: TRNS positive (DR A/R) + SPL negative (CR Sales)', () => {
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE`,
      `ACCNT${t}Accounts Receivable${t}AR`,
      `ACCNT${t}Sales${t}INC`,
      `!TRNS${t}TRNSID${t}TRNSTYPE${t}DATE${t}ACCNT${t}NAME${t}AMOUNT${t}DOCNUM${t}MEMO`,
      `!SPL${t}SPLID${t}TRNSTYPE${t}DATE${t}ACCNT${t}NAME${t}AMOUNT${t}DOCNUM${t}MEMO`,
      `!ENDTRNS`,
      `TRNS${t}1${t}INVOICE${t}01/15/2026${t}Accounts Receivable${t}Acme${t}250.00${t}INV-1001${t}Service rendered`,
      `SPL${t}2${t}INVOICE${t}01/15/2026${t}Sales${t}${t}-250.00${t}${t}Service`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(1);
    const trx = out.transactions[0]!;
    expect(trx.qbType).toBe('INVOICE');
    expect(trx.sourceType).toBe('invoice');
    expect(trx.posts).toBe(true);
    expect(trx.date).toBe('2026-01-15');
    expect(trx.docNum).toBe('INV-1001');
    expect(trx.lines).toHaveLength(2);
    expect(trx.lines[0]?.account).toBe('Accounts Receivable');
    expect(trx.lines[0]?.amount).toBe('250.0000');
    expect(trx.lines[1]?.account).toBe('Sales');
    expect(trx.lines[1]?.amount).toBe('-250.0000');
  });

  it('parses a CHECK block: TRNS negative (CR Bank) + SPL positive (DR Expense)', () => {
    const text = [
      `!TRNS${t}TRNSID${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT${t}DOCNUM`,
      `!SPL${t}SPLID${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT${t}MEMO`,
      `!ENDTRNS`,
      `TRNS${t}1${t}CHECK${t}2026-02-01${t}Checking${t}-75.00${t}1234`,
      `SPL${t}2${t}CHECK${t}2026-02-01${t}Office Expense${t}75.00${t}stationery`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(1);
    const trx = out.transactions[0]!;
    expect(trx.sourceType).toBe('bank_transaction');
    expect(trx.lines[0]?.amount).toBe('-75.0000');
    expect(trx.lines[1]?.amount).toBe('75.0000');
  });

  it('handles multiple SPL rows under one TRNS (split deposit)', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT${t}MEMO`,
      `!ENDTRNS`,
      `TRNS${t}DEPOSIT${t}2026-03-01${t}Checking${t}500.00`,
      `SPL${t}DEPOSIT${t}2026-03-01${t}Sales${t}-300.00${t}Customer A`,
      `SPL${t}DEPOSIT${t}2026-03-01${t}Other Income${t}-200.00${t}Refund`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(1);
    expect(out.transactions[0]?.lines).toHaveLength(3);
    const sumMicros = out.transactions[0]!.lines.reduce((acc, l) => {
      const sign = l.amount.startsWith('-') ? -1 : 1;
      const abs = l.amount.replace('-', '');
      const [whole = '0', frac = ''] = abs.split('.');
      return acc + sign * (parseInt(whole, 10) * 10000 + parseInt((frac + '0000').slice(0, 4), 10));
    }, 0);
    expect(sumMicros).toBe(0); // balanced
  });

  it('maps every common TRNSTYPE to a sourceType', () => {
    const types = [
      ['INVOICE', 'invoice'],
      ['BILL', 'bill'],
      ['PAYMENT', 'payment'],
      ['BILLPMT', 'payment'],
      ['CHECK', 'bank_transaction'],
      ['DEPOSIT', 'bank_transaction'],
      ['TRANSFER', 'bank_transaction'],
      ['CCARD CHARGE', 'bank_transaction'],
      ['GENERAL JOURNAL', 'manual'],
      ['PAYCHECK', 'payroll'],
      ['LIABILITY CHECK', 'payroll'],
      ['CASH SALE', 'invoice'],
      ['CREDIT MEMO', 'invoice'],
    ];
    for (const [qbType] of types) {
      const text = [
        `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
        `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
        `!ENDTRNS`,
        `TRNS${t}${qbType}${t}2026-01-01${t}Acct1${t}10.00`,
        `SPL${t}${qbType}${t}2026-01-01${t}Acct2${t}-10.00`,
        `ENDTRNS`,
      ].join('\n');
      const out = parseIif(text);
      expect(out.transactions, `${qbType} parse`).toHaveLength(1);
    }
    for (const [qbType, expectedSource] of types) {
      const text = [
        `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
        `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
        `!ENDTRNS`,
        `TRNS${t}${qbType}${t}2026-01-01${t}Acct1${t}10.00`,
        `SPL${t}${qbType}${t}2026-01-01${t}Acct2${t}-10.00`,
        `ENDTRNS`,
      ].join('\n');
      const out = parseIif(text);
      expect(out.transactions[0]?.sourceType, `${qbType} -> ${expectedSource}`).toBe(expectedSource);
    }
  });

  it('skips non-posting TRNSTYPEs (ESTIMATE, SALES ORDER, PURCHASE ORDER)', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}ESTIMATE${t}2026-01-01${t}Estimates${t}500.00`,
      `SPL${t}ESTIMATE${t}2026-01-01${t}Estimates Other${t}-500.00`,
      `ENDTRNS`,
      `TRNS${t}SALES ORDER${t}2026-01-01${t}SalesOrd${t}100.00`,
      `SPL${t}SALES ORDER${t}2026-01-01${t}SalesOrd2${t}-100.00`,
      `ENDTRNS`,
      `TRNS${t}INVOICE${t}2026-01-01${t}AR${t}50.00`,
      `SPL${t}INVOICE${t}2026-01-01${t}Sales${t}-50.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(1); // only the INVOICE
    expect(out.transactions[0]?.qbType).toBe('INVOICE');
    expect(out.nonPostingSkipped).toBe(2);
  });

  it('reports per-TRNSTYPE counts including non-posting', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}INVOICE${t}2026-01-01${t}AR${t}10`,
      `SPL${t}INVOICE${t}2026-01-01${t}S${t}-10`,
      `ENDTRNS`,
      `TRNS${t}INVOICE${t}2026-01-02${t}AR${t}20`,
      `SPL${t}INVOICE${t}2026-01-02${t}S${t}-20`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}2026-01-03${t}B${t}-30`,
      `SPL${t}CHECK${t}2026-01-03${t}E${t}30`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactionCounts.INVOICE).toBe(2);
    expect(out.transactionCounts.CHECK).toBe(1);
  });

  it('warns on unclosed TRNS block at EOF and finalises whatever it has', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}INVOICE${t}2026-01-01${t}AR${t}10`,
      `SPL${t}INVOICE${t}2026-01-01${t}S${t}-10`,
      // NO ENDTRNS
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(1);
    expect(out.warnings.some((w) => /unclosed/i.test(w))).toBe(true);
  });

  it('warns on TRNS without prior !TRNS header and skips', () => {
    const text = [
      `TRNS${t}1${t}INVOICE${t}2026-01-01${t}AR${t}10`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(0);
    expect(out.warnings.some((w) => /TRNS row before/.test(w))).toBe(true);
  });

  it('warns on SPL row outside a TRNS block', () => {
    const text = [
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `SPL${t}INVOICE${t}2026-01-01${t}AR${t}10`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.warnings.some((w) => /outside a TRNS block/.test(w))).toBe(true);
  });

  it('handles a real-world style multi-section file (ACCNT + CUST + VEND + multiple TRNS)', () => {
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE`,
      `ACCNT${t}Checking${t}BANK`,
      `ACCNT${t}Accounts Receivable${t}AR`,
      `ACCNT${t}Accounts Payable${t}AP`,
      `ACCNT${t}Sales${t}INC`,
      `ACCNT${t}Office Expense${t}EXP`,
      `!CUST${t}NAME${t}EMAIL`,
      `CUST${t}Acme Corp${t}ap@acme.com`,
      `!VEND${t}NAME`,
      `VEND${t}Office Supply Co`,
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT${t}DOCNUM`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}INVOICE${t}2026-01-15${t}Accounts Receivable${t}500.00${t}INV-1`,
      `SPL${t}INVOICE${t}2026-01-15${t}Sales${t}-500.00`,
      `ENDTRNS`,
      `TRNS${t}BILL${t}2026-01-20${t}Accounts Payable${t}-150.00${t}BILL-1`,
      `SPL${t}BILL${t}2026-01-20${t}Office Expense${t}150.00`,
      `ENDTRNS`,
      `TRNS${t}PAYMENT${t}2026-01-25${t}Checking${t}500.00${t}PAY-1`,
      `SPL${t}PAYMENT${t}2026-01-25${t}Accounts Receivable${t}-500.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.accounts).toHaveLength(5);
    expect(out.customers).toHaveLength(1);
    expect(out.vendors).toHaveLength(1);
    expect(out.transactions).toHaveLength(3);
    expect(out.transactions.map((t) => t.qbType).sort()).toEqual(['BILL', 'INVOICE', 'PAYMENT']);
  });
});
