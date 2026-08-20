import { describe, expect, it } from 'vitest';
import {
  allocatePaymentAcrossLines,
  cashBasisEntryRecognisableAmount,
  recognizeCashBasisDocument,
  recognizeCashBasisTotals,
  type CashBasisDocument,
  type CashBasisEntryShape,
  type CashBasisLine,
} from '../src/modules/ledger/reports.service.js';

/**
 * Cash-basis recognition — pure math only, no database.
 *
 * The accounting rules under test:
 *   • revenue is recognised when cash is RECEIVED, expense when cash is PAID
 *   • an invoice/bill recognises only the paid portion, only on the payment date
 *   • unpaid documents (and unpaid portions) never appear
 *   • voided documents and voided payments leave nothing behind
 *   • allocations sum EXACTLY to the payment — no dropped or duplicated cents
 */

const SCALE = 10000n;

function toMinor(s: string): bigint {
  const [sign, rest] = s.startsWith('-') ? [-1n, s.slice(1)] : [1n, s];
  const [intPart = '0', fracRaw = ''] = rest.split('.');
  const frac = (fracRaw + '0000').slice(0, 4);
  return sign * (BigInt(intPart) * SCALE + BigInt(frac || '0'));
}

function sumMinor(values: readonly string[]): bigint {
  return values.reduce((acc, v) => acc + toMinor(v), 0n);
}

const line = (accountId: string, amount: string): CashBasisLine => ({ accountId, amount });

describe('allocatePaymentAcrossLines — pro rata split', () => {
  it('gives a single-line invoice its whole amount when paid in full', () => {
    const result = allocatePaymentAcrossLines('100.00', [line('rev', '100.00')], '100.00');
    expect(result.lines).toEqual(['100.0000']);
    expect(result.residual).toBe('0.0000');
  });

  it('splits a partial payment pro rata across a multi-line invoice', () => {
    const result = allocatePaymentAcrossLines(
      '1000.00',
      [line('labor', '600.00'), line('materials', '400.00')],
      '250.00',
    );
    // 25% of the invoice was collected, so 25% of each line is income.
    expect(result.lines).toEqual(['150.0000', '100.0000']);
    expect(result.residual).toBe('0.0000');
  });

  it('recognises nothing for a zero payment', () => {
    const result = allocatePaymentAcrossLines('500.00', [line('rev', '500.00')], '0.00');
    expect(result.lines).toEqual(['0.0000']);
    expect(result.residual).toBe('0.0000');
  });

  it('handles a five-line invoice paid one third down', () => {
    const lines = [
      line('a', '100.00'),
      line('b', '200.00'),
      line('c', '300.00'),
      line('d', '150.00'),
      line('e', '250.00'),
    ];
    const result = allocatePaymentAcrossLines('1000.00', lines, '333.33');
    expect(sumMinor(result.lines) + toMinor(result.residual)).toBe(toMinor('333.33'));
    expect(result.lines).toEqual(['33.3330', '66.6660', '99.9990', '49.9995', '83.3325']);
  });
});

describe('allocatePaymentAcrossLines — rounding', () => {
  it('puts the remainder on the largest line and never loses a cent', () => {
    const lines = [line('a', '33.33'), line('b', '33.33'), line('c', '33.34')];
    const result = allocatePaymentAcrossLines('100.00', lines, '33.33');
    // Raw shares truncate to 11.1088 / 11.1088 / 11.1122 = 33.3298; the two
    // ten-thousandths left over land on c, the largest line.
    expect(result.lines).toEqual(['11.1088', '11.1088', '11.1124']);
    expect(sumMinor(result.lines)).toBe(toMinor('33.33'));
  });

  it('sends the remainder to the largest line, not the first line', () => {
    const result = allocatePaymentAcrossLines(
      '99.00',
      [line('small', '1.00'), line('big', '98.00')],
      '10.00',
    );
    expect(result.lines).toEqual(['0.1010', '9.8990']);
    expect(sumMinor(result.lines)).toBe(toMinor('10.00'));
  });

  it('breaks a tie for largest by taking the first line', () => {
    // Total 30.00 against two 10.00 lines: 10.00 of the total is sales tax.
    const result = allocatePaymentAcrossLines(
      '30.00',
      [line('a', '10.00'), line('b', '10.00')],
      '10.00',
    );
    expect(result.lines).toEqual(['3.3334', '3.3333']);
    expect(result.residual).toBe('3.3333');
    expect(sumMinor(result.lines) + toMinor(result.residual)).toBe(toMinor('10.00'));
  });

  it('always adds back up to the payment, over a wide sweep of inputs', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 20260820;
    const next = (max: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let round = 0; round < 400; round += 1) {
      const lineCount = 1 + next(6);
      const lines: CashBasisLine[] = [];
      let subtotal = 0;
      for (let i = 0; i < lineCount; i += 1) {
        const cents = 1 + next(500000);
        subtotal += cents;
        lines.push(line(`acct-${i}`, (cents / 100).toFixed(2)));
      }
      const taxCents = next(2) === 0 ? 0 : next(Math.max(1, Math.floor(subtotal / 10)));
      const total = ((subtotal + taxCents) / 100).toFixed(2);
      const paymentCents = 1 + next(subtotal + taxCents + 5000);
      const payment = (paymentCents / 100).toFixed(2);

      const result = allocatePaymentAcrossLines(total, lines, payment);
      expect(sumMinor(result.lines) + toMinor(result.residual)).toBe(toMinor(payment));
      // No line may go negative or exceed what it actually posted.
      for (const [i, amount] of result.lines.entries()) {
        expect(toMinor(amount) >= 0n).toBe(true);
        expect(toMinor(amount) <= toMinor(lines[i]!.amount)).toBe(true);
      }
    }
  });
});

describe('allocatePaymentAcrossLines — sales tax and overpayment', () => {
  it('keeps the sales-tax share of a payment out of revenue', () => {
    // 100.00 of revenue + 8.25 tax = 108.25 collected.
    const result = allocatePaymentAcrossLines('108.25', [line('rev', '100.00')], '108.25');
    expect(result.lines).toEqual(['100.0000']);
    expect(result.residual).toBe('8.2500');
  });

  it('prorates tax alongside revenue on a partial payment', () => {
    const result = allocatePaymentAcrossLines('108.25', [line('rev', '100.00')], '54.125');
    expect(result.lines).toEqual(['50.0000']);
    expect(result.residual).toBe('4.1250');
  });

  it('caps recognition at the document total and parks the overpayment in residual', () => {
    const result = allocatePaymentAcrossLines('100.00', [line('rev', '100.00')], '150.00');
    expect(result.lines).toEqual(['100.0000']);
    // The extra 50.00 is a customer deposit — a balance-sheet item, not income.
    expect(result.residual).toBe('50.0000');
    expect(sumMinor(result.lines) + toMinor(result.residual)).toBe(toMinor('150.00'));
  });

  it('caps a multi-line overpayment at the line amounts', () => {
    const result = allocatePaymentAcrossLines(
      '300.00',
      [line('a', '100.00'), line('b', '200.00')],
      '500.00',
    );
    expect(result.lines).toEqual(['100.0000', '200.0000']);
    expect(result.residual).toBe('200.0000');
  });

  it('degrades safely on a zero-total document', () => {
    const result = allocatePaymentAcrossLines('0.00', [line('rev', '0.00')], '25.00');
    expect(result.lines).toEqual(['0.0000']);
    expect(result.residual).toBe('25.0000');
  });

  it('never recognises more than posted when lines exceed the stored total', () => {
    // Corrupt data: lines say 200.00, header says 100.00.
    const result = allocatePaymentAcrossLines(
      '100.00',
      [line('a', '100.00'), line('b', '100.00')],
      '100.00',
    );
    expect(result.lines).toEqual(['50.0000', '50.0000']);
    expect(result.residual).toBe('0.0000');
  });
});

describe('recognizeCashBasisDocument', () => {
  const invoice = (payments: CashBasisDocument['payments']): CashBasisDocument => ({
    documentId: 'inv-1',
    side: 'credit',
    total: '1000.00',
    lines: [line('4000', '600.00'), line('4100', '400.00')],
    payments,
  });

  it('recognises nothing for an unpaid invoice', () => {
    expect(recognizeCashBasisDocument(invoice([]))).toEqual([]);
  });

  it('recognises on the payment date, not the invoice date', () => {
    const recognised = recognizeCashBasisDocument(
      invoice([{ paymentId: 'p1', date: '2026-04-15', amount: '500.00' }]),
    );
    expect(recognised).toEqual([
      { accountId: '4000', paymentId: 'p1', date: '2026-04-15', amount: '300.0000' },
      { accountId: '4100', paymentId: 'p1', date: '2026-04-15', amount: '200.0000' },
    ]);
  });

  it('lands every line on its own amount once the document is fully paid', () => {
    // 300.01 split 100.00 / 200.01 never divides evenly across three payments.
    // Allocating each payment on its own truncates 4000 downward every time and
    // leaves it at 99.9999 — a full cent light on a cent-level report. The
    // cumulative allocation has to converge exactly.
    const recognised = recognizeCashBasisDocument({
      documentId: 'inv-drift',
      side: 'credit',
      total: '300.01',
      lines: [line('4000', '100.00'), line('4100', '200.01')],
      payments: [
        { paymentId: 'p1', date: '2026-01-10', amount: '100.00' },
        { paymentId: 'p2', date: '2026-02-10', amount: '100.00' },
        { paymentId: 'p3', date: '2026-03-10', amount: '100.01' },
      ],
    });
    const per = (accountId: string) =>
      sumMinor(recognised.filter((r) => r.accountId === accountId).map((r) => r.amount));
    expect(per('4000')).toBe(toMinor('100.00'));
    expect(per('4100')).toBe(toMinor('200.01'));
    expect(sumMinor(recognised.map((r) => r.amount))).toBe(toMinor('300.01'));
  });

  it('converges on the line amounts however a document is split into instalments', () => {
    let seed = 20260820;
    const next = (max: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let round = 0; round < 200; round += 1) {
      const lineCount = 2 + next(4);
      const lines: CashBasisLine[] = [];
      let subtotalCents = 0;
      for (let i = 0; i < lineCount; i += 1) {
        const cents = 1 + next(200000);
        subtotalCents += cents;
        lines.push(line(`acct-${i}`, (cents / 100).toFixed(2)));
      }
      // Pay the document off in full, in 2-5 uneven instalments.
      const instalments = 2 + next(4);
      const payments: CashBasisDocument['payments'] = [];
      let leftCents = subtotalCents;
      for (let i = 0; i < instalments - 1; i += 1) {
        const part = 1 + next(Math.max(1, Math.floor(leftCents / 2)));
        leftCents -= part;
        payments.push({
          paymentId: `p${i}`,
          date: `2026-0${i + 1}-15`,
          amount: (part / 100).toFixed(2),
        });
      }
      payments.push({
        paymentId: `p${instalments}`,
        date: '2026-09-15',
        amount: (leftCents / 100).toFixed(2),
      });

      const recognised = recognizeCashBasisDocument({
        documentId: `inv-${round}`,
        side: 'credit',
        total: (subtotalCents / 100).toFixed(2),
        lines,
        payments,
      });
      for (const [i, l] of lines.entries()) {
        const got = sumMinor(
          recognised.filter((r) => r.accountId === `acct-${i}`).map((r) => r.amount),
        );
        expect(got).toBe(toMinor(l.amount));
      }
    }
  });

  it('recognises each instalment separately and, in total, exactly the invoice', () => {
    const recognised = recognizeCashBasisDocument(
      invoice([
        { paymentId: 'p2', date: '2026-05-01', amount: '750.00' },
        { paymentId: 'p1', date: '2026-04-01', amount: '250.00' },
      ]),
    );
    // Sorted by payment date regardless of input order.
    expect(recognised.map((r) => r.date)).toEqual([
      '2026-04-01',
      '2026-04-01',
      '2026-05-01',
      '2026-05-01',
    ]);
    const per4000 = recognised.filter((r) => r.accountId === '4000');
    const per4100 = recognised.filter((r) => r.accountId === '4100');
    expect(sumMinor(per4000.map((r) => r.amount))).toBe(toMinor('600.00'));
    expect(sumMinor(per4100.map((r) => r.amount))).toBe(toMinor('400.00'));
  });

  it('flips the sign for a bill so expense lines read debit-positive downstream', () => {
    const bill: CashBasisDocument = {
      documentId: 'bill-1',
      side: 'debit',
      total: '400.00',
      lines: [line('6000', '250.00'), line('6100', '150.00')],
      payments: [{ paymentId: 'p1', date: '2026-04-20', amount: '200.00' }],
    };
    expect(recognizeCashBasisDocument(bill)).toEqual([
      { accountId: '6000', paymentId: 'p1', date: '2026-04-20', amount: '-125.0000' },
      { accountId: '6100', paymentId: 'p1', date: '2026-04-20', amount: '-75.0000' },
    ]);
  });

  it('drops zero slices instead of emitting empty rows', () => {
    const doc: CashBasisDocument = {
      documentId: 'inv-2',
      side: 'credit',
      total: '1000.00',
      lines: [line('4000', '999.99'), line('4100', '0.01')],
      payments: [{ paymentId: 'p1', date: '2026-04-01', amount: '0.01' }],
    };
    const recognised = recognizeCashBasisDocument(doc);
    expect(recognised.map((r) => r.accountId)).toEqual(['4000']);
  });
});

describe('recognizeCashBasisDocument — voids', () => {
  const base: Omit<CashBasisDocument, 'payments' | 'voided'> = {
    documentId: 'inv-9',
    side: 'credit',
    total: '100.00',
    lines: [line('4000', '100.00')],
  };

  it('recognises nothing from a voided document', () => {
    const recognised = recognizeCashBasisDocument({
      ...base,
      voided: true,
      payments: [{ paymentId: 'p1', date: '2026-03-10', amount: '100.00' }],
    });
    expect(recognised).toEqual([]);
  });

  it('leaves no phantom recognition behind a voided payment', () => {
    const recognised = recognizeCashBasisDocument({
      ...base,
      payments: [
        { paymentId: 'p1', date: '2026-03-05', amount: '40.00', voided: true },
        { paymentId: 'p2', date: '2026-03-10', amount: '60.00' },
      ],
    });
    expect(recognised).toEqual([
      { accountId: '4000', paymentId: 'p2', date: '2026-03-10', amount: '60.0000' },
    ]);
  });

  it('re-prorates the survivors when one of several payments is voided', () => {
    const recognised = recognizeCashBasisDocument({
      documentId: 'inv-10',
      side: 'credit',
      total: '900.00',
      lines: [line('4000', '600.00'), line('4100', '300.00')],
      payments: [
        { paymentId: 'p1', date: '2026-03-01', amount: '300.00' },
        { paymentId: 'p2', date: '2026-03-02', amount: '600.00', voided: true },
      ],
    });
    expect(recognised).toEqual([
      { accountId: '4000', paymentId: 'p1', date: '2026-03-01', amount: '200.0000' },
      { accountId: '4100', paymentId: 'p1', date: '2026-03-01', amount: '100.0000' },
    ]);
  });

  it('recognises nothing when every payment is voided', () => {
    const recognised = recognizeCashBasisDocument({
      ...base,
      payments: [{ paymentId: 'p1', date: '2026-03-05', amount: '100.00', voided: true }],
    });
    expect(recognised).toEqual([]);
  });
});

describe('recognizeCashBasisTotals', () => {
  const invoice: CashBasisDocument = {
    documentId: 'inv-1',
    side: 'credit',
    total: '1000.00',
    lines: [line('4000', '600.00'), line('4100', '400.00')],
    payments: [
      { paymentId: 'p1', date: '2026-01-31', amount: '100.00' },
      { paymentId: 'p2', date: '2026-02-15', amount: '400.00' },
    ],
  };

  const bill: CashBasisDocument = {
    documentId: 'bill-1',
    side: 'debit',
    total: '500.00',
    lines: [line('6000', '500.00')],
    payments: [{ paymentId: 'p3', date: '2026-02-20', amount: '250.00' }],
  };

  it('nets invoices and bills into one credit-positive map', () => {
    expect(recognizeCashBasisTotals([invoice, bill])).toEqual([
      { accountId: '4000', amount: '300.0000' },
      { accountId: '4100', amount: '200.0000' },
      { accountId: '6000', amount: '-250.0000' },
    ]);
  });

  it('filters on the recognition date, not the document date', () => {
    // p1 landed 2026-01-31 and drops out even though the invoice is the same.
    expect(
      recognizeCashBasisTotals([invoice, bill], { start: '2026-02-01', end: '2026-02-28' }),
    ).toEqual([
      { accountId: '4000', amount: '240.0000' },
      { accountId: '4100', amount: '160.0000' },
      { accountId: '6000', amount: '-250.0000' },
    ]);
  });

  it('includes both window edges', () => {
    expect(recognizeCashBasisTotals([invoice], { start: '2026-01-31', end: '2026-01-31' })).toEqual([
      { accountId: '4000', amount: '60.0000' },
      { accountId: '4100', amount: '40.0000' },
    ]);
  });

  it('nets a refund against income on the same account', () => {
    const creditMemo: CashBasisDocument = {
      documentId: 'bill-refund',
      side: 'debit',
      total: '100.00',
      lines: [line('4000', '100.00')],
      payments: [{ paymentId: 'p9', date: '2026-02-10', amount: '100.00' }],
    };
    expect(recognizeCashBasisTotals([invoice, creditMemo])).toEqual([
      { accountId: '4000', amount: '200.0000' },
      { accountId: '4100', amount: '200.0000' },
    ]);
  });

  it('returns nothing when every document is unpaid', () => {
    expect(recognizeCashBasisTotals([{ ...invoice, payments: [] }])).toEqual([]);
  });
});

describe('cashBasisEntryRecognisableAmount', () => {
  const shape = (s: Partial<CashBasisEntryShape> & { total: string }): CashBasisEntryShape => ({
    arDebit: '0.00',
    arCredit: '0.00',
    apDebit: '0.00',
    apCredit: '0.00',
    movesCash: false,
    ...s,
  });

  it('recognises a whole line on an entry that touches neither A/R nor A/P', () => {
    // DR 6000 fuel 80.00 / CR 1000 bank 80.00 — cash and accrual agree.
    const e = shape({ total: '80.00', movesCash: true });
    expect(cashBasisEntryRecognisableAmount(e, 'debit', '80.00')).toBe('80.0000');
  });

  it('recognises none of an invoice: the revenue is funded by the receivable', () => {
    // DR 1100 A/R 10000.00 / CR 4000 sales 10000.00.
    const e = shape({ total: '10000.00', arDebit: '10000.00' });
    expect(cashBasisEntryRecognisableAmount(e, 'credit', '10000.00')).toBe('0.0000');
  });

  it('recognises none of a bill: the expense is funded by the payable', () => {
    // DR 6000 materials 500.00 / CR 2000 A/P 500.00.
    const e = shape({ total: '500.00', apCredit: '500.00' });
    expect(cashBasisEntryRecognisableAmount(e, 'debit', '500.00')).toBe('0.0000');
  });

  it('recognises a merchant fee netted out of a customer receipt', () => {
    // DR 1000 bank 970.00 / DR 6300 fees 30.00 / CR 1100 A/R 1000.00. The A/R
    // credit is the money arriving, so the fee really was paid on this date.
    const e = shape({ total: '1000.00', arCredit: '1000.00', movesCash: true });
    expect(cashBasisEntryRecognisableAmount(e, 'debit', '30.00')).toBe('30.0000');
  });

  it('recognises an early-pay discount taken when a bill is settled', () => {
    // DR 2000 A/P 1000.00 / CR 1000 bank 980.00 / CR 4900 discounts 20.00.
    const e = shape({ total: '1000.00', apDebit: '1000.00', movesCash: true });
    expect(cashBasisEntryRecognisableAmount(e, 'credit', '20.00')).toBe('20.0000');
  });

  it('recognises the expense half of an imported check that also settles A/P', () => {
    // DR 6000 supplies 200.00 / DR 2000 A/P 300.00 / CR 1000 bank 500.00.
    const e = shape({ total: '500.00', apDebit: '300.00', movesCash: true });
    expect(cashBasisEntryRecognisableAmount(e, 'debit', '200.00')).toBe('200.0000');
  });

  it('does NOT deduct a bad-debt write-off, which moves no money', () => {
    // DR 6900 bad debt 500.00 / CR 1100 A/R 500.00. Cash basis never recognised
    // the income, so writing it off must not create a deduction.
    const e = shape({ total: '500.00', arCredit: '500.00' });
    expect(cashBasisEntryRecognisableAmount(e, 'debit', '500.00')).toBe('0.0000');
  });

  it('leaves nothing behind when a void reverses an invoice', () => {
    // DR 4000 sales 10000.00 / CR 1100 A/R 10000.00, no cash on the entry.
    const e = shape({ total: '10000.00', arCredit: '10000.00' });
    expect(cashBasisEntryRecognisableAmount(e, 'debit', '10000.00')).toBe('0.0000');
  });

  it('leaves nothing behind when a void reverses a bill', () => {
    // DR 2000 A/P 500.00 / CR 6000 materials 500.00, no cash on the entry.
    const e = shape({ total: '500.00', apDebit: '500.00' });
    expect(cashBasisEntryRecognisableAmount(e, 'credit', '500.00')).toBe('0.0000');
  });

  it('prorates revenue when an invoice is keyed with a down payment on it', () => {
    // DR 1100 A/R 600.00 / DR 1000 bank 400.00 / CR 4000 sales 1000.00.
    const e = shape({ total: '1000.00', arDebit: '600.00', movesCash: true });
    expect(cashBasisEntryRecognisableAmount(e, 'credit', '1000.00')).toBe('400.0000');
  });

  it('prorates an expense when a bill is part-paid on the same entry', () => {
    // DR 6000 materials 1000.00 / CR 2000 A/P 600.00 / CR 1000 bank 400.00.
    const e = shape({ total: '1000.00', apCredit: '600.00', movesCash: true });
    expect(cashBasisEntryRecognisableAmount(e, 'debit', '1000.00')).toBe('400.0000');
  });

  it('keeps the sign and never recognises more than the line posted', () => {
    const e = shape({ total: '1000.00', arDebit: '250.00', movesCash: true });
    expect(cashBasisEntryRecognisableAmount(e, 'credit', '-100.00')).toBe('-75.0000');
    expect(cashBasisEntryRecognisableAmount(e, 'credit', '100.00')).toBe('75.0000');
  });

  it('degrades safely on a zero-total entry', () => {
    expect(cashBasisEntryRecognisableAmount(shape({ total: '0.00' }), 'debit', '10.00')).toBe(
      '0.0000',
    );
  });
});
