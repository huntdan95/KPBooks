import { describe, expect, it } from 'vitest';
import { parseBankCsv } from '../src/modules/banking/csv-parser.js';

describe('parseBankCsv', () => {
  it('parses Wells Fargo style: Date,Description,Amount,Balance', () => {
    const csv = [
      'Date,Description,Amount,Balance',
      '01/15/2026,Coffee Shop,-4.50,1234.56',
      '01/16/2026,Customer Payment,500.00,1734.56',
    ].join('\n');
    const out = parseBankCsv(csv);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({
      date: '2026-01-15',
      description: 'Coffee Shop',
      amount: '-4.5000',
      balance: '1234.5600',
    });
    expect(out.rows[1]).toMatchObject({
      date: '2026-01-16',
      description: 'Customer Payment',
      amount: '500.0000',
    });
  });

  it('parses Chase style: Date,Description,Debit,Credit,Balance (debit -> negative)', () => {
    const csv = [
      'Posting Date,Description,Debit,Credit,Balance',
      '02/01/2026,ATM Withdrawal,40.00,,500.00',
      '02/02/2026,Direct Deposit,,2500.00,3000.00',
    ].join('\n');
    const out = parseBankCsv(csv);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]?.amount).toBe('-40.0000');
    expect(out.rows[1]?.amount).toBe('2500.0000');
  });

  it('handles quoted fields with commas in the description', () => {
    const csv = [
      'Date,Description,Amount',
      '03/01/2026,"AMZN MKTPLC, INC",-89.99',
    ].join('\n');
    const out = parseBankCsv(csv);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.description).toBe('AMZN MKTPLC, INC');
    expect(out.rows[0]?.amount).toBe('-89.9900');
  });

  it('handles $ and thousands commas in amounts', () => {
    const csv = ['Date,Description,Amount', '04/01/2026,Big Sale,"$1,234.56"'].join('\n');
    const out = parseBankCsv(csv);
    expect(out.rows[0]?.amount).toBe('1234.5600');
  });

  it('handles parens-as-negative accounting convention', () => {
    const csv = ['Date,Description,Amount', '04/02/2026,Refund,(50.00)'].join('\n');
    const out = parseBankCsv(csv);
    expect(out.rows[0]?.amount).toBe('-50.0000');
  });

  it('skips rows with zero amount + warns', () => {
    const csv = [
      'Date,Description,Amount',
      '04/03/2026,Zero,0.00',
      '04/04/2026,Real,10.00',
    ].join('\n');
    const out = parseBankCsv(csv);
    expect(out.rows).toHaveLength(1);
    expect(out.warnings.some((w) => /zero/.test(w))).toBe(true);
  });

  it('rejects CSVs missing a date column', () => {
    const csv = ['Description,Amount', 'Coffee,5.00'].join('\n');
    const out = parseBankCsv(csv);
    expect(out.rows).toHaveLength(0);
    expect(out.warnings[0]).toMatch(/date column/i);
  });

  it('rejects CSVs missing a description column', () => {
    const csv = ['Date,Amount', '01/01/2026,5.00'].join('\n');
    const out = parseBankCsv(csv);
    expect(out.rows).toHaveLength(0);
    expect(out.warnings[0]).toMatch(/description column/i);
  });

  it('rejects CSVs missing an amount AND debit/credit columns', () => {
    const csv = ['Date,Description', '01/01/2026,Coffee'].join('\n');
    const out = parseBankCsv(csv);
    expect(out.rows).toHaveLength(0);
    expect(out.warnings[0]).toMatch(/Amount column/i);
  });

  it('handles ISO date format', () => {
    const csv = ['Date,Description,Amount', '2026-05-01,Test,100.00'].join('\n');
    const out = parseBankCsv(csv);
    expect(out.rows[0]?.date).toBe('2026-05-01');
  });
});
