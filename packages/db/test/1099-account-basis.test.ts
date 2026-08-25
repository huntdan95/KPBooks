/**
 * 1099 year-end summary against a real Postgres.
 *
 * The practice this was built for gives every 1099 contractor their own
 * expense sub-account ("Subcontractors:Carlos Arana") and posts journal
 * entries straight to it — there are no vendor bills or payments to total.
 * The original query summed the payments table, which returns zero for that
 * charting style, so a whole filing season would have reported nothing.
 *
 * The rule under test: an expense account named for the contractor wins;
 * otherwise fall back to posted vendor payments. Never both, or a book that
 * enters a bill and then pays it counts the same money twice.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/schema/index.js';
import { nineteenNinetyNineSummary } from '../../../apps/api/src/modules/ledger/reports.service.js';
import { createTestCompany, dropTestCompany, withCompanyTx } from './setup';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function runSummary(fx: { companyId: string; userId: string }, year: number) {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const db = drizzle(client, { schema });
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(dsql`SELECT set_config('app.current_company', ${fx.companyId}, true)`);
      await tx.execute(dsql`SELECT set_config('app.current_user', ${fx.userId}, true)`);
      await tx.execute(dsql`SELECT set_config('app.current_role', 'owner', true)`);
      return nineteenNinetyNineSummary(
        tx as unknown as Parameters<typeof nineteenNinetyNineSummary>[0],
        year,
      );
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

describeIfDb('1099 summary — expense-account charting', () => {
  let fxPromise: ReturnType<typeof createTestCompany> | null = null;
  const getFx = () => (fxPromise ??= createTestCompany('ninetynine'));

  afterAll(async () => {
    if (fxPromise) await dropTestCompany((await fxPromise).companyId);
  });

  it('totals the expense sub-account, falls back to payments, and never sums both', async () => {
    const fx = await getFx();

    await withCompanyTx(fx, 'owner', async (tx) => {
      // Codes sit in a 99xx range: the fixture company already ships a seeded
      // chart of accounts and accounts_company_code_idx is unique.
      const mkAccount = async (
        code: string,
        name: string,
        type = 'expense',
        subtype = 'expense',
      ) => {
        const [r] = await tx<{ id: string }[]>`
          INSERT INTO accounts (company_id, code, name, type, subtype)
          VALUES (${fx.companyId}, ${code}, ${name}, ${type}::account_type,
                  ${subtype}::account_subtype)
          RETURNING id`;
        return r!.id;
      };
      const mkVendor = async (name: string, tin: string | null) => {
        const [r] = await tx<{ id: string }[]>`
          INSERT INTO vendors (company_id, display_name, is_1099_vendor, tax_id)
          VALUES (${fx.companyId}, ${name}, true, ${tin})
          RETURNING id`;
        return r!.id;
      };
      const entry = async (date: string, lines: Array<[string, string, string]>) => {
        const [e] = await tx<{ id: string }[]>`
          INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
          VALUES (${fx.companyId}, ${date}, 'manual'::journal_source_type, ${fx.userId})
          RETURNING id`;
        for (const [acct, d, c] of lines) {
          await tx`
            INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
            VALUES (${e!.id}, ${fx.companyId}, ${acct}, ${d}, ${c})`;
        }
        return e!.id;
      };
      const bank = await mkAccount('9900', 'Bank', 'asset', 'bank');

      // A. Charted as an expense sub-account, paid by journal entry. The LEAF
      //    of the account path is what matches the vendor name.
      const carlosAcct = await mkAccount('9901', 'Subcontractors:Carlos Arana');
      await mkVendor('Carlos Arana', '904-88-0662');
      await entry('2026-02-10', [
        [carlosAcct, '650.0000', '0'],
        [bank, '0', '650.0000'],
      ]);
      await entry('2026-06-04', [
        [carlosAcct, '1200.0000', '0'],
        [bank, '0', '1200.0000'],
      ]);
      // Prior year — must not count toward 2026.
      await entry('2025-12-31', [
        [carlosAcct, '9999.0000', '0'],
        [bank, '0', '9999.0000'],
      ]);

      // B. No expense account of their own: falls back to vendor payments.
      const elena = await mkVendor('Elena', null);
      const contractLabor = await mkAccount('9903', 'Contract labor');
      const elenaEntry = await entry('2026-03-02', [
        [contractLabor, '800.0000', '0'],
        [bank, '0', '800.0000'],
      ]);
      await tx`
        INSERT INTO payments (company_id, vendor_id, payment_type, status, payment_date,
                              payment_method, bank_account_id, amount, posted_journal_entry_id)
        VALUES (${fx.companyId}, ${elena}, 'vendor_sent'::payment_type, 'posted'::payment_status,
                '2026-03-02', 'check'::payment_method, ${bank}, '800.0000', ${elenaEntry})`;

      // C. BOTH an expense account and a payment for the same money — the
      //    double-count trap. The account must win, alone.
      const dimasAcct = await mkAccount('9902', 'Subcontractors:Dimas Reyes Martinez');
      const dimas = await mkVendor('Dimas Reyes Martinez', '946-94-5616');
      const dimasEntry = await entry('2026-04-01', [
        [dimasAcct, '5000.0000', '0'],
        [bank, '0', '5000.0000'],
      ]);
      await tx`
        INSERT INTO payments (company_id, vendor_id, payment_type, status, payment_date,
                              payment_method, bank_account_id, amount, posted_journal_entry_id)
        VALUES (${fx.companyId}, ${dimas}, 'vendor_sent'::payment_type, 'posted'::payment_status,
                '2026-04-01', 'check'::payment_method, ${bank}, '5000.0000', ${dimasEntry})`;
    });

    const report = await runSummary(fx, 2026);
    const by = (name: string) => report.rows.find((r) => r.displayName === name)!;

    // A: 650 + 1200, with the prior-year entry excluded.
    expect(by('Carlos Arana').total).toBe('1850.0000');
    expect(by('Carlos Arana').source).toBe('account');
    expect(by('Carlos Arana').sourceAccountName).toBe('Subcontractors:Carlos Arana');
    expect(by('Carlos Arana').meetsThreshold).toBe(true);
    expect(by('Carlos Arana').missingTaxId).toBe(false);

    // B: no account of their own, so payments are used.
    expect(by('Elena').total).toBe('800.0000');
    expect(by('Elena').source).toBe('payments');
    expect(by('Elena').sourceAccountName).toBeNull();
    // Above $600 with no TIN on file — exactly what prep must surface.
    expect(by('Elena').missingTaxId).toBe(true);

    // C: the trap. 5000, NOT 10000.
    expect(by('Dimas Reyes Martinez').total).toBe('5000.0000');
    expect(by('Dimas Reyes Martinez').source).toBe('account');

    // Totals roll up from the same single-source-per-contractor rule.
    expect(report.totals.total).toBe('7650.0000');
    expect(report.totals.aboveThreshold).toBe(3);
    expect(report.totals.missingTaxIdAboveThreshold).toBe(1);
  });
});
