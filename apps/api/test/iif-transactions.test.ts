/**
 * IIF transaction parser: TRNSTYPE coverage, sign convention, date/number
 * normalisation, multi-block files, error handling on malformed blocks.
 *
 * Commit logic is tested via integration in packages/db once we have the
 * test harness that posts journal_entries; for now this file focuses on the
 * parser, which is the algorithmic core.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMissingAccounts,
  normaliseAmount,
  normaliseDate,
  parseIif,
} from '../src/modules/imports/iif.js';

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
  it('rejects impossible calendar dates (2/30, 4/31, non-leap 2/29)', () => {
    // A 1-31 bounds check alone lets these through; Postgres would then
    // reject the literal mid-import and abort the whole batch.
    expect(normaliseDate('2/30/2026')).toBeNull();
    expect(normaliseDate('4/31/2026')).toBeNull();
    expect(normaliseDate('9/31/2025')).toBeNull();
    expect(normaliseDate('2/29/2027')).toBeNull();
    expect(normaliseDate('2026-02-31')).toBeNull(); // ISO passthrough validates too
    expect(normaliseDate('2/29/2028')).toBe('2028-02-29'); // real leap day still parses
    expect(normaliseDate('12/31/2026')).toBe('2026-12-31');
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
  it('rejects decimal-comma amounts instead of silently shifting the magnitude', () => {
    // "1.234,56" / "1234,56" / "1,50" are continental decimal-comma shapes
    // (conversion tools and hand-edits; QBD's US/CA/UK editions all write
    // period decimals). Stripping the comma as a thousands separator posted
    // them 100-1000x off -- and because every line of a block shifted
    // identically, the block still balanced and posted with zero warnings.
    expect(normaliseAmount('1.234,56')).toBeNull();
    expect(normaliseAmount('1234,56')).toBeNull();
    expect(normaliseAmount('1,50')).toBeNull();
    expect(normaliseAmount('1 234,56')).toBeNull();
    expect(normaliseAmount('-1.234,56')).toBeNull();
    expect(normaliseAmount('(1.234,56)')).toBeNull();
    // Genuine US shapes keep working (3 digits after every comma).
    expect(normaliseAmount('1,234.56')).toBe('1234.5600');
    expect(normaliseAmount('$1,234')).toBe('1234.0000');
  });
  it('reads "(-250.00)" as negative 250, never positive', () => {
    // The paren handler and the sign toggle used to XOR each other:
    // "(-250.00)" came out POSITIVE, importing conversion-tool checks with
    // debit/credit inverted (bank debited instead of credited).
    expect(normaliseAmount('(-250.00)')).toBe('-250.0000');
    expect(normaliseAmount('(250.00)')).toBe('-250.0000');
    expect(normaliseAmount('-250.00')).toBe('-250.0000');
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

  it('treats the documented plural non-posting keywords (ESTIMATES, SALES ORDERS, PURCHASE ORDERS) as non-posting', () => {
    // Intuit's IIF reference uses the PLURAL keywords; the space/hyphen-only
    // normalised fallback cannot bridge singular/plural, so a missing plural
    // fell through to { posts: true } and booked fabricated income/expense
    // for every open estimate in the customer's file.
    for (const qbType of ['ESTIMATES', 'SALES ORDERS', 'PURCHASE ORDERS']) {
      const text = [
        `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
        `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
        `!ENDTRNS`,
        `TRNS${t}${qbType}${t}2026-01-15${t}Estimates${t}500.00`,
        `SPL${t}${qbType}${t}2026-01-15${t}Construction Income${t}-500.00`,
        `ENDTRNS`,
      ].join('\n');
      const out = parseIif(text);
      expect(out.transactions, `${qbType} must not post`).toHaveLength(0);
      expect(out.nonPostingSkipped, `${qbType} skipped as non-posting`).toBe(1);
    }
  });

  it('maps CREDIT CARD, CCARD REFUND, and CASH REFUND to real sourceTypes, not the import fallback', () => {
    // All three are documented QBD TRNSTYPE keywords; falling through to
    // sourceType 'import' posts the right amounts but misclassifies every
    // credit-card charge/refund for source_type-filtered views and reports.
    const types: [string, string][] = [
      ['CREDIT CARD', 'bank_transaction'],
      ['CCARD REFUND', 'bank_transaction'],
      ['CASH REFUND', 'invoice'],
    ];
    for (const [qbType, expectedSource] of types) {
      const text = [
        `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
        `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
        `!ENDTRNS`,
        `TRNS${t}${qbType}${t}2026-01-01${t}Acct1${t}-10.00`,
        `SPL${t}${qbType}${t}2026-01-01${t}Acct2${t}10.00`,
        `ENDTRNS`,
      ].join('\n');
      const out = parseIif(text);
      expect(out.transactions, `${qbType} parse`).toHaveLength(1);
      expect(out.transactions[0]?.sourceType, `${qbType} -> ${expectedSource}`).toBe(expectedSource);
      expect(out.transactions[0]?.posts).toBe(true);
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

  it('skips a block with an impossible calendar date and warns at preview', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}2/30/2026${t}Checking${t}-75.00`,
      `SPL${t}CHECK${t}2/30/2026${t}Office Expense${t}75.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}2/28/2026${t}Checking${t}-10.00`,
      `SPL${t}CHECK${t}2/28/2026${t}Office Expense${t}10.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(1);
    expect(out.transactions[0]?.date).toBe('2026-02-28');
    expect(out.warnings.some((w) => /invalid TRNS date "2\/30\/2026"/.test(w))).toBe(true);
  });

  it('warns at preview and excludes blocks that do not balance beyond a cent', () => {
    // Drift previously previewed clean and was only dropped at commit --
    // after the user confirmed -- leaving the bank balance off. (Drift of
    // one cent or less is auto-plugged instead; see the Rounding tests.)
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}2026-01-10${t}Checking${t}-1234.56`,
      `SPL${t}CHECK${t}2026-01-10${t}Office Expense${t}1234.54`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}2026-01-11${t}Checking${t}-50.00`,
      `SPL${t}CHECK${t}2026-01-11${t}Office Expense${t}50.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(1); // only the balanced block
    expect(out.transactions[0]?.date).toBe('2026-01-11');
    const warning = out.warnings.find((w) => /out of balance/.test(w));
    expect(warning).toBeTruthy();
    expect(warning).toMatch(/-0\.0200/); // debits minus credits
    expect(warning).toMatch(/row 4/); // points at the TRNS row
    // The dropped block is also reported structurally so the UI's per-type
    // table and the completion screen can disclose it (it never reaches the
    // commit, so posted/skipped counts cannot account for it).
    expect(out.excludedTransactions).toEqual([
      { rowNumber: 4, qbType: 'CHECK', reason: expect.stringMatching(/out of balance/) },
    ]);
  });

  it('auto-plugs 1-cent drift with an explicit Rounding line instead of dropping the block', () => {
    // Multicurrency home-value exports can carry 1-cent drift; dropping a
    // $12,000 deposit whole over $0.01 loses the entire transaction. The
    // plug keeps the entry netting to exactly zero via a visible line.
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}DEPOSIT${t}2026-01-10${t}Checking${t}12000.00`,
      `SPL${t}DEPOSIT${t}2026-01-10${t}Sales${t}-11999.99`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(1);
    expect(out.excludedTransactions).toEqual([]);
    const trx = out.transactions[0]!;
    expect(trx.lines).toHaveLength(3);
    const plug = trx.lines[2]!;
    expect(plug.account).toBe('Rounding');
    expect(plug.amount).toBe('-0.0100');
    // The block now balances to exactly zero.
    const sum = trx.lines.reduce((acc, l) => {
      const sign = l.amount.startsWith('-') ? -1 : 1;
      return acc + sign * Number(l.amount.replace('-', '').replace('.', ''));
    }, 0);
    expect(sum).toBe(0);
    const warning = out.warnings.find((w) => /Rounding/.test(w));
    expect(warning).toBeTruthy();
    expect(warning).toMatch(/out of balance by 0\.0100/);
    // The plug account flows through missingAccounts like any referenced
    // name, so it is auto-created (as expense) when the chart lacks it.
    const missing = buildMissingAccounts(out, new Set(['Checking', 'Sales']));
    expect(missing.map((m) => m.name)).toContain('Rounding');
  });

  it('reports parse-excluded blocks structurally so an all-excluded type cannot read as "non-posting"', () => {
    // One unbalanced CHECK + one balanced DEPOSIT: transactionCounts.CHECK
    // is 1 but no CHECK survives to preview.transactions. Without
    // excludedTransactions the UI labelled that row "skipped (non-posting)"
    // -- wrong on both counts.
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}2026-01-10${t}Checking${t}-100.00`,
      `SPL${t}CHECK${t}2026-01-10${t}Office Expense${t}99.98`, // truncated cents
      `ENDTRNS`,
      `TRNS${t}DEPOSIT${t}2026-01-11${t}Checking${t}50.00`,
      `SPL${t}DEPOSIT${t}2026-01-11${t}Sales${t}-50.00`,
      `ENDTRNS`,
      // Posting block with only its TRNS line (truncated file).
      `TRNS${t}CHECK${t}2026-01-12${t}Checking${t}-10.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactionCounts.CHECK).toBe(2);
    expect(out.transactionCounts.DEPOSIT).toBe(1);
    expect(out.transactions.map((x) => x.qbType)).toEqual(['DEPOSIT']);
    expect(out.excludedTransactions).toHaveLength(2);
    expect(out.excludedTransactions[0]).toEqual({
      rowNumber: 4,
      qbType: 'CHECK',
      reason: expect.stringMatching(/out of balance/),
    });
    expect(out.excludedTransactions[1]).toEqual({
      rowNumber: 10,
      qbType: 'CHECK',
      reason: expect.stringMatching(/only 1 line/),
    });
  });

  it('tracks TRNS-row parse failures structurally (counts + excludedTransactions), without per-SPL noise', () => {
    // A block whose TRNS row itself fails (mangled DATE, bad AMOUNT, missing
    // ACCNT) used to bypass finalisePending entirely: absent from
    // transactionCounts AND excludedTransactions, visible only as free-text
    // warnings (plus one noisy "SPL row outside a TRNS block" per split).
    // The preview summary and the post-commit screen then read
    // "0 skipped / 0 excluded" while the register was silently short.
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}13/45/2026${t}Checking${t}-75.00`, // mangled date
      `SPL${t}CHECK${t}13/45/2026${t}Office Expense${t}75.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}2026-01-10${t}Checking${t}not-a-number`, // bad amount
      `SPL${t}CHECK${t}2026-01-10${t}Office Expense${t}10.00`,
      `ENDTRNS`,
      `TRNS${t}DEPOSIT${t}2026-01-11${t}${t}50.00`, // missing ACCNT
      `SPL${t}DEPOSIT${t}2026-01-11${t}Sales${t}-50.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}2026-01-12${t}Checking${t}-20.00`, // good block
      `SPL${t}CHECK${t}2026-01-12${t}Office Expense${t}20.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(1);
    expect(out.transactions[0]?.date).toBe('2026-01-12');
    // Every failed block is counted per type AND excluded structurally.
    expect(out.transactionCounts.CHECK).toBe(3);
    expect(out.transactionCounts.DEPOSIT).toBe(1);
    expect(out.excludedTransactions).toEqual([
      { rowNumber: 4, qbType: 'CHECK', reason: expect.stringMatching(/invalid TRNS date "13\/45\/2026"/) },
      { rowNumber: 7, qbType: 'CHECK', reason: expect.stringMatching(/invalid TRNS amount/) },
      { rowNumber: 10, qbType: 'DEPOSIT', reason: expect.stringMatching(/missing ACCNT/) },
    ]);
    // The splits of a failed block are swallowed silently -- no misleading
    // "outside a TRNS block" warning per orphaned SPL row.
    expect(out.warnings.some((w) => /outside a TRNS block/.test(w))).toBe(false);
  });

  it('tracks a TRNS row missing TRNSTYPE as an excluded UNKNOWN block', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}${t}2026-01-10${t}Checking${t}-75.00`,
      `SPL${t}${t}2026-01-10${t}Office Expense${t}75.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(0);
    expect(out.transactionCounts.UNKNOWN).toBe(1);
    expect(out.excludedTransactions).toEqual([
      { rowNumber: 4, qbType: 'UNKNOWN', reason: expect.stringMatching(/missing TRNSTYPE/) },
    ]);
  });

  it('counts a non-posting block with a broken TRNS row as non-posting, not as a data error', () => {
    // An ESTIMATE with a mangled date would never have posted anyway --
    // reporting it as an excluded data error would send the user fixing
    // rows that change nothing.
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}ESTIMATE${t}13/45/2026${t}Estimates${t}500.00`,
      `SPL${t}ESTIMATE${t}13/45/2026${t}Construction Income${t}-500.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(0);
    expect(out.transactionCounts.ESTIMATE).toBe(1);
    expect(out.nonPostingSkipped).toBe(1);
    expect(out.excludedTransactions).toEqual([]);
  });

  it('still previews voided (all-zero) blocks as balanced transactions', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}2026-03-10${t}Checking${t}0.00`,
      `SPL${t}CHECK${t}2026-03-10${t}Office Expense${t}0.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(1);
    expect(out.warnings).toEqual([]);
  });

  it('flags a probable D/M/Y-locale export at file level', () => {
    // "25/05/2026" is 25 May from an en-GB machine: it can't be month-first,
    // and nothing else in the file contradicts day-first -- so the whole
    // file is re-read day-first (see the dedicated tests below).
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}25/05/2026${t}Checking${t}-75.00`,
      `SPL${t}CHECK${t}25/05/2026${t}Office Expense${t}75.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}08/05/2026${t}Checking${t}-10.00`,
      `SPL${t}CHECK${t}08/05/2026${t}Office Expense${t}10.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    const fileWarning = out.warnings.find((w) => /day\/month\/year/.test(w));
    expect(fileWarning).toBeTruthy();
    expect(fileWarning).toMatch(/M\/D\/YYYY/);
  });

  it('re-reads the whole file day-first when every readable date says D/M/Y', () => {
    // en-GB export: checks dated 5 March and 25 March. The old behaviour
    // dropped 25/03 and silently posted 05/03 as May 3rd; now the day-13+
    // date proves day-first (and nothing proves month-first), so BOTH import
    // into March.
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}05/03/2026${t}Checking${t}-75.00`,
      `SPL${t}CHECK${t}05/03/2026${t}Office Expense${t}75.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}25/03/2026${t}Checking${t}-10.00`,
      `SPL${t}CHECK${t}25/03/2026${t}Office Expense${t}10.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(2);
    expect(out.transactions.map((x) => x.date)).toEqual(['2026-03-05', '2026-03-25']);
    const fileWarning = out.warnings.find((w) => /read as day\/month\/year/i.test(w));
    expect(fileWarning).toBeTruthy();
  });

  it('does NOT re-read day-first when other dates prove month-first (mixed/corrupt file)', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}01/15/2026${t}Checking${t}-75.00`, // day 15 proves M/D/Y
      `SPL${t}CHECK${t}01/15/2026${t}Office Expense${t}75.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}25/05/2026${t}Checking${t}-10.00`, // day-first-shaped
      `SPL${t}CHECK${t}25/05/2026${t}Office Expense${t}10.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    // Month-first parse is kept; the contradictory row is dropped and warned.
    expect(out.transactions).toHaveLength(1);
    expect(out.transactions[0]?.date).toBe('2026-01-15');
    expect(out.warnings.some((w) => /invalid TRNS date "25\/05\/2026"/.test(w))).toBe(true);
    expect(out.warnings.some((w) => /unambiguously month\/day\/year/.test(w))).toBe(true);
  });

  it('warns when every date is ambiguous (day <= 12), the case a D/M/Y export imports silently transposed', () => {
    // 05/03 and 10/03 read "cleanly" as May 3 / Oct 3 under M/D/Y -- if the
    // file actually came from a D/M/Y machine every date is transposed and
    // there is no other tell. The file-level warning is the fix.
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}05/03/2026${t}Checking${t}-75.00`,
      `SPL${t}CHECK${t}05/03/2026${t}Office Expense${t}75.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}10/03/2026${t}Checking${t}-10.00`,
      `SPL${t}CHECK${t}10/03/2026${t}Office Expense${t}10.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(2); // still imports as M/D/Y
    expect(out.transactions.map((x) => x.date)).toEqual(['2026-05-03', '2026-10-03']);
    const warning = out.warnings.find((w) => /month\/day order cannot\s+be verified/i.test(w));
    expect(warning).toBeTruthy();
  });

  it('does not raise the ambiguity warning when a day 13-31 proves month-first', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}05/03/2026${t}Checking${t}-75.00`,
      `SPL${t}CHECK${t}05/03/2026${t}Office Expense${t}75.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}01/15/2026${t}Checking${t}-10.00`,
      `SPL${t}CHECK${t}01/15/2026${t}Office Expense${t}10.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(2);
    expect(out.warnings).toEqual([]);
  });

  it('normaliseDate reads day-first when asked', () => {
    expect(normaliseDate('05/03/2026', true)).toBe('2026-03-05');
    expect(normaliseDate('25/03/2026', true)).toBe('2026-03-25');
    expect(normaliseDate('03/25/2026', true)).toBeNull(); // month 25 is invalid day-first
    expect(normaliseDate('2026-03-05', true)).toBe('2026-03-05'); // ISO unaffected
  });

  it('excludes a decimal-comma block loudly instead of posting it at the wrong magnitude', () => {
    // A EUR 1,234.56 check written as "1.234,56" used to normalise to
    // 1.2345 on BOTH lines: the block balanced, passed every check, and
    // posted a $1.23 check with zero warnings. It must now fail per-row and
    // surface in excludedTransactions.
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}2026-01-10${t}Checking${t}-1.234,56`,
      `SPL${t}CHECK${t}2026-01-10${t}Office Expense${t}1.234,56`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(0);
    expect(out.warnings.some((w) => /invalid TRNS amount "-1\.234,56"/.test(w))).toBe(true);
    expect(out.excludedTransactions).toEqual([
      { rowNumber: 4, qbType: 'CHECK', reason: expect.stringMatching(/invalid TRNS amount/) },
    ]);
  });

  it('does not flip the whole file to day-first on a date that is invalid in BOTH orders', () => {
    // "31/02/2026" is not a real date as M/D/Y (month 31) OR as D/M/Y
    // (Feb 31) -- plain corruption, not locale evidence. It used to count
    // as day-first evidence and, with every other date ambiguous (day <=
    // 12), re-read the ENTIRE file as day/month/year: a check dated
    // 05/03/2026 (May 3) silently posted to March 5.
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}31/02/2026${t}Checking${t}-75.00`,
      `SPL${t}CHECK${t}31/02/2026${t}Office Expense${t}75.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}05/03/2026${t}Checking${t}-10.00`,
      `SPL${t}CHECK${t}05/03/2026${t}Office Expense${t}10.00`,
      `ENDTRNS`,
      `TRNS${t}CHECK${t}10/03/2026${t}Checking${t}-20.00`,
      `SPL${t}CHECK${t}10/03/2026${t}Office Expense${t}20.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    // Dates stay month-first; only the corrupt row is dropped, per-row.
    expect(out.transactions.map((x) => x.date)).toEqual(['2026-05-03', '2026-10-03']);
    expect(out.warnings.some((w) => /invalid TRNS date "31\/02\/2026"/.test(w))).toBe(true);
    expect(out.warnings.some((w) => /read as day\/month\/year/i.test(w))).toBe(false);
    // The remaining dates are all ambiguous, so the order-cannot-be-verified
    // disclosure still fires.
    expect(out.warnings.some((w) => /cannot\s+be verified/i.test(w))).toBe(true);
    // A VALID day-first date (25 May) still flips the heuristic -- only the
    // invalid-in-both-orders shape stopped counting.
    const valid = parseIif(
      [
        `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
        `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
        `!ENDTRNS`,
        `TRNS${t}CHECK${t}25/05/2026${t}Checking${t}-75.00`,
        `SPL${t}CHECK${t}25/05/2026${t}Office Expense${t}75.00`,
        `ENDTRNS`,
      ].join('\n'),
    );
    expect(valid.transactions.map((x) => x.date)).toEqual(['2026-05-25']);
    expect(valid.warnings.some((w) => /read as day\/month\/year/i.test(w))).toBe(true);
  });

  it('does not raise the D/M/Y warning for plain garbage dates', () => {
    const text = [
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}13/15/2026${t}Checking${t}-75.00`,
      `SPL${t}CHECK${t}13/15/2026${t}Office Expense${t}75.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.warnings.some((w) => /invalid TRNS date/.test(w))).toBe(true);
    expect(out.warnings.some((w) => /day\/month\/year/.test(w))).toBe(false);
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
