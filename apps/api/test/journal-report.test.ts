import { describe, expect, it } from 'vitest';
import {
  excelSerialToIso,
  parseCsvRows,
  parseJournalCsv,
  parseJournalRows,
  parseReportAmount,
  parseReportDate,
  resolveLeafAccountNames,
} from '../src/modules/imports/journal-report.js';

/**
 * Shapes here are taken from a real "Bello Construction - Journals.xlsx"
 * produced by QuickBooks Desktop Pro Plus 34.0D, not invented: interleaved
 * blank spacer columns, Excel serial dates, single-space "blank" cells,
 * continuation rows, and per-transaction TOTAL rows.
 */
const HEADER = ['', 'Trans #', '', 'Type', '', 'Date', '', 'Num', '', 'Name', '', 'Memo', '', 'Account', '', 'Debit', '', 'Credit'];
const row = (...cells: string[]): string[] => cells;

describe('parseReportAmount', () => {
  it('reads the formats a report emits', () => {
    expect(parseReportAmount('1,234.56')).toBe('1234.5600');
    expect(parseReportAmount('$1,234.56')).toBe('1234.5600');
    expect(parseReportAmount('(1,234.56)')).toBe('-1234.5600');
    expect(parseReportAmount('-650.00')).toBe('-650.0000');
    expect(parseReportAmount('650')).toBe('650.0000');
    expect(parseReportAmount('0.00')).toBe('0.0000');
  });

  it('rejects non-numeric cells rather than coercing them to zero', () => {
    for (const junk of ['', ' ', '-', 'TOTAL', 'n/a', '1.2.3', 'abc']) {
      expect(parseReportAmount(junk), junk).toBeNull();
    }
  });
});

describe('excel serial dates', () => {
  it('decodes against the 1899-12-30 epoch', () => {
    // 46027 is the first transaction date in the real customer export.
    expect(excelSerialToIso(46027)).toBe('2026-01-05');
    expect(excelSerialToIso(45292)).toBe('2024-01-01');
  });

  it('accepts a serial that arrived as text', () => {
    expect(parseReportDate('46027')).toBe('2026-01-05');
  });

  it('rejects impossible calendar dates instead of passing them to Postgres', () => {
    // 2/30 aborts the whole import transaction at the DB layer, so it has to
    // die here as one excluded row instead.
    expect(parseReportDate('2/30/2026')).toBeNull();
    expect(parseReportDate('4/31/2026')).toBeNull();
    expect(parseReportDate('2/29/2027')).toBeNull();
    expect(parseReportDate('2/29/2028')).toBe('2028-02-29'); // real leap day
  });

  it('honours day-first locales', () => {
    expect(parseReportDate('05/01/2026')).toBe('2026-05-01');
    expect(parseReportDate('05/01/2026', true)).toBe('2026-01-05');
  });
});

describe('parseCsvRows', () => {
  it('handles quoted fields, escaped quotes and embedded commas', () => {
    const rows = parseCsvRows('a,"b,c","he said ""hi""",d\r\n1,2,3,4\r\n');
    expect(rows[0]).toEqual(['a', 'b,c', 'he said "hi"', 'd']);
    expect(rows[1]).toEqual(['1', '2', '3', '4']);
  });

  it('strips a BOM so the first header still matches', () => {
    expect(parseCsvRows('﻿Trans #,Type')[0]![0]).toBe('Trans #');
  });
});

describe('parseJournalRows', () => {
  it('parses the real interleaved/serial-date/TOTAL-row shape', () => {
    const rows = [
      ['Bello Construction'],
      ['Journal'],
      [],
      HEADER,
      row('', '3353', '', 'Bill', '', '46027', '', 'z', '', 'Carlos Arana', '', ' ', '', 'Accounts Payable', '', '', '', '650.00'),
      row('', '', '', ' ', '', '', '', '', '', 'Carlos Arana', '', ' ', '', 'Carlos Arana', '', '650.00', '', ''),
      row('', '', '', '', '', '', '', '', '', '', '', '', '', 'TOTAL', '', '650.00', '', '650.00'),
      row('', '3354', '', 'General Journal', '', '46028', '', '5', '', '', '', 'adj', '', 'GASOLINE', '', '100.00', '', ''),
      row('', '', '', '', '', '', '', '', '', '', '', '', '', 'BANK ACCOUNT:BANK OF AMERICA', '', '', '', '100.00'),
      ['TOTAL', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '750.00', '', '750.00'],
    ];
    const p = parseJournalRows(rows);
    expect(p.excludedTransactions).toEqual([]);
    expect(p.transactions).toHaveLength(2);
    expect(p.transactionCounts).toEqual({ Bill: 1, 'General Journal': 1 });

    const bill = p.transactions[0]!;
    expect(bill.date).toBe('2026-01-05');
    expect(bill.sourceType).toBe('bill');
    expect(bill.docNum).toBe('z');
    // Credit is negative, debit positive, and the pair nets to zero.
    expect(bill.lines.map((l) => l.amount)).toEqual(['-650.0000', '650.0000']);
    expect(bill.lines[1]!.account).toBe('Carlos Arana');

    const je = p.transactions[1]!;
    expect(je.sourceType).toBe('manual');
    expect(je.date).toBe('2026-01-06');
    expect(je.lines).toHaveLength(2);
  });

  it('excludes an out-of-balance transaction instead of posting it', () => {
    const rows = [
      HEADER,
      row('', '1', '', 'Bill', '', '46027', '', '', '', 'X', '', '', '', 'Accounts Payable', '', '', '', '650.00'),
      row('', '', '', '', '', '', '', '', '', 'X', '', '', '', 'GASOLINE', '', '600.00', '', ''),
    ];
    const p = parseJournalRows(rows);
    expect(p.transactions).toHaveLength(0);
    expect(p.excludedTransactions[0]!.reason).toMatch(/differ by -50\.0000/);
  });

  it('excludes a single-line transaction', () => {
    const rows = [
      HEADER,
      row('', '1', '', 'Bill', '', '46027', '', '', '', 'X', '', '', '', 'GASOLINE', '', '10.00', '', ''),
    ];
    expect(parseJournalRows(rows).excludedTransactions[0]!.reason).toMatch(/at least 2/);
  });

  it('reports a helpful error when the file is not a Journal report', () => {
    const p = parseJournalRows([['Customer', 'Balance'], ['Acme', '100']]);
    expect(p.transactions).toHaveLength(0);
    expect(p.warnings[0]).toMatch(/does not look like a QuickBooks Journal report/i);
  });

  it('accepts a single Amount column instead of Debit/Credit', () => {
    const p = parseJournalRows([
      ['Type', 'Date', 'Account', 'Amount'],
      ['Check', '01/05/2026', 'GASOLINE', '100.00'],
      ['', '', 'BANK ACCOUNT', '-100.00'],
    ]);
    expect(p.transactions).toHaveLength(1);
    expect(p.transactions[0]!.lines.map((l) => l.amount)).toEqual(['100.0000', '-100.0000']);
  });
});

describe('parseJournalCsv', () => {
  it('parses a CSV export end to end', () => {
    const csv =
      'Bello Construction\nJournal\n\nTrans #,Type,Date,Num,Name,Memo,Account,Debit,Credit\n' +
      '1,Bill,01/05/2026,z,Carlos Arana,,Accounts Payable,,"650.00"\n' +
      ',,,,,,Subcontractors:Carlos Arana,"650.00",\n';
    const p = parseJournalCsv(csv);
    expect(p.transactions).toHaveLength(1);
    expect(p.transactions[0]!.date).toBe('2026-01-05');
    expect(p.transactions[0]!.lines[1]!.account).toBe('Subcontractors:Carlos Arana');
  });
});

describe('resolveLeafAccountNames', () => {
  const build = (account: string) =>
    parseJournalRows([
      ['Type', 'Date', 'Account', 'Debit', 'Credit'],
      ['Bill', '01/05/2026', 'Accounts Payable', '', '650.00'],
      ['', '', account, '650.00', ''],
    ]);

  it('rewrites a leaf name to the existing full sub-account path', () => {
    const p = build('Carlos Arana');
    const existing = new Set(['Accounts Payable', 'Subcontractors:Carlos Arana']);
    const r = resolveLeafAccountNames(p, existing);
    expect(r.resolved).toBe(1);
    expect(p.transactions[0]!.lines[1]!.account).toBe('Subcontractors:Carlos Arana');
  });

  it('refuses to guess when a leaf is ambiguous', () => {
    const p = build('Tire One');
    const existing = new Set(['Accounts Payable', 'SUPPLIES:Tire One', 'Auto and Truck Expenses:Tire One']);
    const r = resolveLeafAccountNames(p, existing);
    expect(r.resolved).toBe(0);
    expect(r.ambiguous).toEqual(['Tire One']);
    expect(p.transactions[0]!.lines[1]!.account).toBe('Tire One');
    expect(p.warnings.join(' ')).toMatch(/more than one account/);
  });

  it('leaves an already-qualified path and an exact top-level match alone', () => {
    const p = build('GASOLINE');
    const r = resolveLeafAccountNames(p, new Set(['Accounts Payable', 'GASOLINE']));
    expect(r.resolved).toBe(0);
    expect(p.transactions[0]!.lines[1]!.account).toBe('GASOLINE');
  });
});
