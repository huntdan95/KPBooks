/**
 * Cash-basis P&L against a real Postgres.
 *
 * apps/api/test/cash-basis.test.ts covers the pure recognisers — given
 * documents and entry shapes, does the arithmetic come out right. It cannot
 * cover the half that decides WHICH rows become those documents and shapes,
 * and that half is SQL: the A/R//A/P split, the subledger-document lookup
 * behind the `unlinkedAccrualActivity` disclosure, the void filters, and the
 * cent rounding on the way out. A mistake there puts wrong numbers on a tax
 * return, so it is exercised here, where a database exists.
 *
 * This is the one test that reaches across from packages/db into apps/api. The
 * embedded-Postgres harness lives here (test/global-setup.ts) and apps/api has
 * no database at test time; duplicating the harness to avoid one import would
 * cost more than it buys.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/schema/index.js';
import { profitAndLoss } from '../../../apps/api/src/modules/ledger/reports.service.js';
import { createTestCompany, dropTestCompany, withCompanyTx } from './setup';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * profitAndLoss() takes a Drizzle handle, so this opens its own one, sets the
 * same RLS GUCs the API's withTenantTx does, and runs the report inside a
 * transaction — exactly the shape production uses.
 */
async function runPnl(
  fx: { companyId: string; userId: string },
  start: string,
  end: string,
  basis: 'accrual' | 'cash',
) {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const db = drizzle(client, { schema });
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(dsql`SELECT set_config('app.current_company', ${fx.companyId}, true)`);
      await tx.execute(dsql`SELECT set_config('app.current_user', ${fx.userId}, true)`);
      await tx.execute(dsql`SELECT set_config('app.current_role', 'owner', true)`);
      return profitAndLoss(tx as unknown as Parameters<typeof profitAndLoss>[0], start, end, basis);
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

describeIfDb('cash-basis P&L — recognition and disclosure', () => {
  let fxPromise: ReturnType<typeof createTestCompany> | null = null;
  const getFx = () => (fxPromise ??= createTestCompany('cashbasis'));

  afterAll(async () => {
    if (fxPromise) await dropTestCompany((await fxPromise).companyId);
  });

  it('recognises what the money did and discloses only the unrecoverable gap', async () => {
    const fx = await getFx();
    await withCompanyTx(fx, 'owner', async (tx) => {
      const mk = async (code: string, name: string, type: string, subtype: string) => {
        const [r] = await tx<{ id: string }[]>`
          INSERT INTO accounts (company_id, code, name, type, subtype)
          VALUES (${fx.companyId}, ${code}, ${name}, ${type}::account_type, ${subtype}::account_subtype)
          RETURNING id`;
        return r!.id;
      };
      const ar = await mk('1100', 'A/R', 'asset', 'accounts_receivable');
      const ap = await mk('2000', 'A/P', 'liability', 'accounts_payable');
      const disc = await mk('4900', 'Discounts', 'revenue', 'income');
      const fees = await mk('6300', 'Merchant fees', 'expense', 'expense');
      const badDebt = await mk('6900', 'Bad debt', 'expense', 'expense');

      const entry = async (
        date: string,
        sourceType: string,
        sourceId: string | null,
        lines: Array<[string, string, string]>,
      ) => {
        const [e] = await tx<{ id: string }[]>`
          INSERT INTO journal_entries (company_id, entry_date, source_type, source_id, created_by)
          VALUES (${fx.companyId}, ${date}, ${sourceType}::journal_source_type, ${sourceId}, ${fx.userId})
          RETURNING id`;
        for (const [acct, d, c] of lines) {
          await tx`
            INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
            VALUES (${e!.id}, ${fx.companyId}, ${acct}, ${d}, ${c})`;
        }
        return e!.id;
      };

      // ── A. native invoice 10,000 on 03-01, paid in full 03-15 ────────────
      const [cust] = await tx<{ id: string }[]>`
        INSERT INTO customers (company_id, display_name) VALUES (${fx.companyId}, 'Acme') RETURNING id`;
      const [inv] = await tx<{ id: string }[]>`
        INSERT INTO invoices (company_id, customer_id, invoice_number, invoice_date, due_date,
                              subtotal, tax_amount, total, balance_due, status, posted_journal_entry_id)
        VALUES (${fx.companyId}, ${cust!.id}, 'INV-1001', '2026-03-01', '2026-03-31',
                '10000.0000','0','10000.0000','0','paid',
                ${await entry('2026-03-01', 'invoice', null, [
                  [ar, '10000.0000', '0'],
                  [fx.revenueAccountId, '0', '10000.0000'],
                ])})
        RETURNING id`;
      // point the entry's source_id at the invoice, like postEntry does
      await tx`UPDATE journal_entries SET source_id = ${inv!.id}
               WHERE id = (SELECT posted_journal_entry_id FROM invoices WHERE id = ${inv!.id})`;
      await tx`INSERT INTO invoice_lines (invoice_id, company_id, line_number, description, quantity, unit_price, amount, account_id)
               VALUES (${inv!.id}, ${fx.companyId}, 1, 'Work', '1', '10000.0000', '10000.0000', ${fx.revenueAccountId})`;
      const payEntry = await entry('2026-03-15', 'payment', null, [
        [fx.cashAccountId, '10000.0000', '0'],
        [ar, '0', '10000.0000'],
      ]);
      const [pay] = await tx<{ id: string }[]>`
        INSERT INTO payments (company_id, payment_type, customer_id, payment_date, payment_method,
                              bank_account_id, amount, status, posted_journal_entry_id)
        VALUES (${fx.companyId}, 'customer_received', ${cust!.id}, '2026-03-15', 'check',
                ${fx.cashAccountId}, '10000.0000', 'posted', ${payEntry}) RETURNING id`;
      await tx`UPDATE journal_entries SET source_id = ${pay!.id} WHERE id = ${payEntry}`;
      await tx`INSERT INTO payment_applications (payment_id, company_id, invoice_id, amount)
               VALUES (${pay!.id}, ${fx.companyId}, ${inv!.id}, '10000.0000')`;

      // ── B. IIF-style invoice: GL only, no invoices row ───────────────────
      await entry('2026-04-01', 'invoice', '11111111-1111-4111-8111-111111111111', [
        [ar, '5000.0000', '0'],
        [fx.revenueAccountId, '0', '5000.0000'],
      ]);

      // ── C. receipt banked net of a merchant fee ──────────────────────────
      await entry('2026-05-10', 'manual', null, [
        [fx.cashAccountId, '970.0000', '0'],
        [fees, '30.0000', '0'],
        [ar, '0', '1000.0000'],
      ]);

      // ── D. early-pay discount on settling A/P ────────────────────────────
      await entry('2026-05-20', 'manual', null, [
        [ap, '1000.0000', '0'],
        [fx.cashAccountId, '0', '980.0000'],
        [disc, '0', '20.0000'],
      ]);

      // ── E. bad-debt write-off: no cash, must NOT be deductible ───────────
      await entry('2026-06-01', 'manual', null, [
        [badDebt, '500.0000', '0'],
        [ar, '0', '500.0000'],
      ]);

      // ── F. plain cash expense, no A/R or A/P anywhere ────────────────────
      await entry('2026-06-05', 'bank_transaction', null, [
        [fx.expenseAccountId, '250.0000', '0'],
        [fx.cashAccountId, '0', '250.0000'],
      ]);

    });

    const pnl = await runPnl(fx, '2026-01-01', '2026-12-31', 'cash');
    const amt = (code: string) =>
      [...pnl.revenue, ...pnl.expenses].find((r) => r.code === code)?.amount;

    // A: recognised on the payment date, and NOT disclosed as excluded.
    expect(amt('4000')).toBe('10000.0000');
    // C: the merchant fee survives the mixed entry.
    expect(amt('6300')).toBe('30.0000');
    // D: the discount survives too.
    expect(amt('4900')).toBe('20.0000');
    // E: bad debt is not a cash deduction.
    expect(amt('6900')).toBe('0.0000');
    // F: unchanged direct activity.
    expect(amt('5000')).toBe('250.0000');

    expect(pnl.totalRevenue).toBe('10020.0000');
    expect(pnl.totalExpenses).toBe('280.0000');
    expect(pnl.netIncome).toBe('9740.0000');

    // Disclosure: ONLY B (5,000 of IIF revenue) and E (500 of write-off).
    expect(pnl.unlinkedAccrualActivity).toEqual({
      revenue: '5000.0000',
      expenses: '500.0000',
    });

    // Line items foot to the printed totals.
    const sum = (rows: Array<{ amount: string }>) =>
      rows.reduce((a, r) => a + Math.round(Number(r.amount) * 100), 0);
    expect(sum(pnl.revenue)).toBe(Math.round(Number(pnl.totalRevenue) * 100));
    expect(sum(pnl.expenses)).toBe(Math.round(Number(pnl.totalExpenses) * 100));

    // Accrual is untouched by any of this.
    const accrual = await runPnl(fx, '2026-01-01', '2026-12-31', 'accrual');
    expect(accrual.totalRevenue).toBe('15020.0000');
    expect(accrual.unlinkedAccrualActivity).toBeUndefined();
  });
});

describeIfDb('cash-basis P&L — voids, rounding, cross-window (integration)', () => {
  let fxPromise: ReturnType<typeof createTestCompany> | null = null;
  const getFx = () => (fxPromise ??= createTestCompany('cashbasis2'));

  afterAll(async () => {
    if (fxPromise) await dropTestCompany((await fxPromise).companyId);
  });

  it('rounds to cents, ignores voids, and carries allocation across the window edge', async () => {
    const fx = await getFx();
    await withCompanyTx(fx, 'owner', async (tx) => {
      const mk = async (code: string, name: string, type: string, subtype: string) => {
        const [r] = await tx<{ id: string }[]>`
          INSERT INTO accounts (company_id, code, name, type, subtype)
          VALUES (${fx.companyId}, ${code}, ${name}, ${type}::account_type, ${subtype}::account_subtype)
          RETURNING id`;
        return r!.id;
      };
      const ar = await mk('1100', 'A/R', 'asset', 'accounts_receivable');
      const rev2 = await mk('4100', 'Materials', 'revenue', 'income');
      const rev3 = await mk('4200', 'Voided', 'revenue', 'income');

      const entry = async (
        date: string,
        sourceType: string,
        sourceId: string | null,
        lines: Array<[string, string, string]>,
      ) => {
        const [e] = await tx<{ id: string }[]>`
          INSERT INTO journal_entries (company_id, entry_date, source_type, source_id, created_by)
          VALUES (${fx.companyId}, ${date}, ${sourceType}::journal_source_type, ${sourceId}, ${fx.userId})
          RETURNING id`;
        for (const [acct, d, c] of lines) {
          await tx`INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
                   VALUES (${e!.id}, ${fx.companyId}, ${acct}, ${d}, ${c})`;
        }
        return e!.id;
      };
      const [cust] = await tx<{ id: string }[]>`
        INSERT INTO customers (company_id, display_name) VALUES (${fx.companyId}, 'Beta') RETURNING id`;

      const mkInvoice = async (
        num: string,
        date: string,
        total: string,
        status: string,
        lines: Array<[string, string]>,
      ) => {
        const e = await entry(date, 'invoice', null, [
          [ar, total, '0'],
          ...lines.map(([acct, amt]) => [acct, '0', amt] as [string, string, string]),
        ]);
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO invoices (company_id, customer_id, invoice_number, invoice_date, due_date,
                                subtotal, tax_amount, total, balance_due, status, posted_journal_entry_id)
          VALUES (${fx.companyId}, ${cust!.id}, ${num}, ${date}, ${date}, ${total}, '0', ${total},
                  '0', ${status}::invoice_status, ${e}) RETURNING id`;
        await tx`UPDATE journal_entries SET source_id = ${row!.id} WHERE id = ${e}`;
        let n = 1;
        for (const [acct, amt] of lines) {
          await tx`INSERT INTO invoice_lines (invoice_id, company_id, line_number, description, quantity, unit_price, amount, account_id)
                   VALUES (${row!.id}, ${fx.companyId}, ${n}, 'L', '1', ${amt}, ${amt}, ${acct})`;
          n += 1;
        }
        return { id: row!.id, entryId: e };
      };

      const mkPayment = async (date: string, amount: string, invoiceId: string, status: string) => {
        const e = await entry(date, 'payment', null, [
          [fx.cashAccountId, amount, '0'],
          [ar, '0', amount],
        ]);
        const [p] = await tx<{ id: string }[]>`
          INSERT INTO payments (company_id, payment_type, customer_id, payment_date, payment_method,
                                bank_account_id, amount, status, posted_journal_entry_id)
          VALUES (${fx.companyId}, 'customer_received', ${cust!.id}, ${date}, 'check',
                  ${fx.cashAccountId}, ${amount}, 'posted', ${e}) RETURNING id`;
        await tx`UPDATE journal_entries SET source_id = ${p!.id} WHERE id = ${e}`;
        await tx`INSERT INTO payment_applications (payment_id, company_id, invoice_id, amount)
                 VALUES (${p!.id}, ${fx.companyId}, ${invoiceId}, ${amount})`;
        if (status === 'void') {
          const rev = await entry(date, 'reversal', e, [
            [ar, amount, '0'],
            [fx.cashAccountId, '0', amount],
          ]);
          await tx`UPDATE payments SET status = 'void', voided_at = now(), voided_journal_entry_id = ${rev}
                   WHERE id = ${p!.id}`;
        }
        return p!.id;
      };

      // G. 1,000.00 invoice split 600/400, one 333.33 payment in the window.
      const g = await mkInvoice('INV-G', '2026-01-05', '1000.0000', 'partial', [
        [fx.revenueAccountId, '600.0000'],
        [rev2, '400.0000'],
      ]);
      await mkPayment('2026-02-01', '333.3300', g.id, 'posted');

      // H. Voided invoice + the reversal a void writes. Must recognise nothing
      //    and disclose nothing (a document DOES sit behind the reversal).
      const h = await mkInvoice('INV-H', '2026-03-01', '500.0000', 'open', [[rev3, '500.0000']]);
      const hRev = await entry('2026-03-02', 'reversal', h.entryId, [
        [rev3, '500.0000', '0'],
        [ar, '0', '500.0000'],
      ]);
      await tx`UPDATE invoices SET status = 'void', voided_at = now(), voided_journal_entry_id = ${hRev}
               WHERE id = ${h.id}`;

      // I. 300.01 invoice, one payment BEFORE the window and two inside it.
      const i = await mkInvoice('INV-I', '2025-11-01', '300.0100', 'paid', [
        [fx.revenueAccountId, '100.0000'],
        [rev2, '200.0100'],
      ]);
      await mkPayment('2025-12-01', '100.0000', i.id, 'posted');
      await mkPayment('2026-04-01', '100.0000', i.id, 'posted');
      await mkPayment('2026-05-01', '100.0100', i.id, 'posted');

      // J. A voided payment leaves nothing behind.
      const j = await mkInvoice('INV-J', '2026-06-01', '90.0000', 'open', [[rev3, '90.0000']]);
      await mkPayment('2026-06-05', '90.0000', j.id, 'void');
    });

    const pnl = await runPnl(fx, '2026-01-01', '2026-12-31', 'cash');
    const amt = (code: string) => pnl.revenue.find((r) => r.code === code)?.amount;

    // G (199.998 -> 200.00) + I's in-window share (66.6678 -> 66.67).
    expect(amt('4000')).toBe('266.6700');
    // G (133.332 -> 133.33) + I's in-window share (133.3422 -> 133.34).
    expect(amt('4100')).toBe('266.6700');
    // H voided, J's only payment voided.
    expect(amt('4200')).toBe('0.0000');

    // Whole cents, and the column foots to the printed total.
    for (const r of [...pnl.revenue, ...pnl.expenses]) {
      expect(r.amount.endsWith('00')).toBe(true);
    }
    const sum = (rows: Array<{ amount: string }>) =>
      rows.reduce((a, r) => a + Math.round(Number(r.amount) * 100), 0);
    expect(sum(pnl.revenue)).toBe(Math.round(Number(pnl.totalRevenue) * 100));
    expect(pnl.totalRevenue).toBe('533.3400');

    // No phantom disclosure from the void, and nothing from the paid invoices.
    expect(pnl.unlinkedAccrualActivity).toEqual({ revenue: '0.0000', expenses: '0.0000' });

    // Across the whole life of INV-I every line lands on its own amount.
    const life = await runPnl(fx, '2025-01-01', '2026-12-31', 'cash');
    const lifeAmt = (code: string) => life.revenue.find((r) => r.code === code)?.amount;
    // 4000: INV-I's 100.00 in full + G's 200.00 share. 4100: 200.01 + 133.33.
    expect(lifeAmt('4000')).toBe('300.0000');
    expect(lifeAmt('4100')).toBe('333.3400');
  });
});
