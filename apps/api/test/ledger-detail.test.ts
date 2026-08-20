import { describe, expect, it } from 'vitest';
import {
  ledgerDocumentTypeOf,
  ledgerRunningBalances,
  normalBalanceOf,
} from '../src/modules/ledger/reports.service.js';

/**
 * General-ledger / account-detail drill-down — pure math only, no database.
 *
 * The accounting rules under test:
 *   • asset and expense accounts are debit-positive; liability, equity and
 *     revenue accounts are credit-positive
 *   • the running balance is the opening balance plus every row through the
 *     current one, signed by that normal balance
 *   • a page that starts mid-ledger resumes from the carried balance, so
 *     paginating a busy account never restarts the column
 *   • balances are exact at NUMERIC(19,4) — no float drift, ever
 */

const row = (debit: string, credit: string) => ({ debit, credit });

describe('normalBalanceOf', () => {
  it('makes asset and expense accounts debit-positive', () => {
    expect(normalBalanceOf('asset')).toBe('debit');
    expect(normalBalanceOf('expense')).toBe('debit');
  });

  it('makes liability, equity and revenue accounts credit-positive', () => {
    expect(normalBalanceOf('liability')).toBe('credit');
    expect(normalBalanceOf('equity')).toBe('credit');
    expect(normalBalanceOf('revenue')).toBe('credit');
  });
});

describe('ledgerRunningBalances — debit-normal accounts', () => {
  it('grows a bank account on debits and shrinks it on credits', () => {
    const balances = ledgerRunningBalances('debit', '1000.00', [
      row('500.0000', '0.0000'),
      row('0.0000', '200.0000'),
      row('0.0000', '1300.0000'),
    ]);
    expect(balances).toEqual(['1500.0000', '1300.0000', '0.0000']);
  });

  it('takes a bank account negative when it is overdrawn', () => {
    const balances = ledgerRunningBalances('debit', '100.0000', [row('0.0000', '250.0000')]);
    expect(balances).toEqual(['-150.0000']);
  });

  it('starts from a negative opening balance', () => {
    const balances = ledgerRunningBalances('debit', '-75.0000', [row('100.0000', '0.0000')]);
    expect(balances).toEqual(['25.0000']);
  });

  it('returns nothing for an account with no rows in the period', () => {
    expect(ledgerRunningBalances('debit', '4200.0000', [])).toEqual([]);
  });
});

describe('ledgerRunningBalances — credit-normal accounts', () => {
  it('grows a revenue account on credits, not debits', () => {
    // The whole point of normal-balance signing: a 1,000 credit to income must
    // read +1,000 on the ledger page, never -1,000.
    const balances = ledgerRunningBalances('credit', '0.0000', [
      row('0.0000', '1000.0000'),
      row('250.0000', '0.0000'),
    ]);
    expect(balances).toEqual(['1000.0000', '750.0000']);
  });

  it('grows an A/P liability when a bill is entered and shrinks it when paid', () => {
    const balances = ledgerRunningBalances('credit', '2500.0000', [
      row('0.0000', '900.0000'), // bill entered
      row('900.0000', '0.0000'), // bill paid
    ]);
    expect(balances).toEqual(['3400.0000', '2500.0000']);
  });

  it('signs a revenue account the opposite way from a debit-normal one', () => {
    const rows = [row('0.0000', '600.0000')];
    expect(ledgerRunningBalances('credit', '0.0000', rows)).toEqual(['600.0000']);
    expect(ledgerRunningBalances('debit', '0.0000', rows)).toEqual(['-600.0000']);
  });
});

describe('ledgerRunningBalances — voids and reversals', () => {
  it('nets a void back to where the ledger started', () => {
    // An invoice debits A/R; voiding it writes the mirror credit. The running
    // balance must come back to the opening figure with both rows on the page.
    const balances = ledgerRunningBalances('debit', '0.0000', [
      row('1250.0000', '0.0000'),
      row('0.0000', '1250.0000'),
    ]);
    expect(balances).toEqual(['1250.0000', '0.0000']);
  });
});

describe('ledgerRunningBalances — pagination carry', () => {
  const rows = [
    row('10.0000', '0.0000'),
    row('20.0000', '0.0000'),
    row('0.0000', '5.0000'),
    row('30.0000', '0.0000'),
    row('0.0000', '15.0000'),
  ];

  it('resumes page 2 exactly where page 1 closed', () => {
    const whole = ledgerRunningBalances('debit', '100.0000', rows);
    const pageOne = ledgerRunningBalances('debit', '100.0000', rows.slice(0, 2));
    // pageOpeningBalance for offset=2 is the balance after row 2 — which is
    // what the windowed prior_debit/prior_credit sums in SQL reconstruct.
    const pageTwo = ledgerRunningBalances('debit', pageOne[1]!, rows.slice(2));

    expect(pageOne).toEqual(whole.slice(0, 2));
    expect(pageTwo).toEqual(whole.slice(2));
  });

  it('closes on the same balance however the rows are paginated', () => {
    const whole = ledgerRunningBalances('credit', '0.0000', rows);
    let carry = '0.0000';
    const stitched: string[] = [];
    for (let i = 0; i < rows.length; i += 2) {
      const page = ledgerRunningBalances('credit', carry, rows.slice(i, i + 2));
      stitched.push(...page);
      carry = page[page.length - 1] ?? carry;
    }
    expect(stitched).toEqual(whole);
  });
});

describe('ledgerRunningBalances — exactness', () => {
  it('keeps sub-cent amounts exact across many rows', () => {
    const tenThousandth = Array.from({ length: 10_000 }, () => row('0.0001', '0.0000'));
    const balances = ledgerRunningBalances('debit', '0.0000', tenThousandth);
    expect(balances[0]).toBe('0.0001');
    expect(balances[balances.length - 1]).toBe('1.0000');
  });

  it('does not drift on amounts a float would round', () => {
    const balances = ledgerRunningBalances('debit', '0.0000', [
      row('0.1000', '0.0000'),
      row('0.2000', '0.0000'),
    ]);
    expect(balances[1]).toBe('0.3000');
  });

  it('accepts the shorter decimal strings NUMERIC can hand back', () => {
    const balances = ledgerRunningBalances('debit', '0', [row('1.5', '0'), row('0', '0.25')]);
    expect(balances).toEqual(['1.5000', '1.2500']);
  });
});

describe('ledgerDocumentTypeOf', () => {
  it('names subledger documents the way a preparer names them', () => {
    expect(ledgerDocumentTypeOf('invoice')).toBe('invoice');
    expect(ledgerDocumentTypeOf('bill')).toBe('bill');
    expect(ledgerDocumentTypeOf('payment')).toBe('payment');
  });

  it('calls a hand-keyed entry a "journal"', () => {
    expect(ledgerDocumentTypeOf('manual')).toBe('journal');
  });

  it('calls a reversal a "journal" only when nothing sits behind it', () => {
    // A void of an invoice/bill/payment resolves through to that document in
    // SQL, so the row arrives here as 'invoice' with isReversal set. This
    // mapping is the fallback for reversing a plain journal entry.
    expect(ledgerDocumentTypeOf('reversal')).toBe('journal');
  });

  it('keeps the remaining source types distinguishable', () => {
    expect(ledgerDocumentTypeOf('bank_transaction')).toBe('bank_transaction');
    expect(ledgerDocumentTypeOf('reconciliation')).toBe('reconciliation');
    expect(ledgerDocumentTypeOf('payroll')).toBe('payroll');
    expect(ledgerDocumentTypeOf('import')).toBe('import');
  });

  it('falls back to "journal" for a source type it has never seen', () => {
    expect(ledgerDocumentTypeOf('something_new')).toBe('journal');
  });
});
