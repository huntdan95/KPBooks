/**
 * Bills: posting writes a balanced JE (DR expense, CR A/P), lock-after-post
 * trigger blocks edits, RLS keeps bills isolated, unique (company_id, bill_number).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCompany, dropTestCompany, getAdminSql, withCompanyTx } from './setup';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

interface BillFixture {
  vendorId: string;
  apAccountId: string;
}

async function seedVendorAndAp(
  fx: Awaited<ReturnType<typeof createTestCompany>>,
  vendorName: string,
): Promise<BillFixture> {
  const sql = getAdminSql();
  const [vendor] = await sql<{ id: string }[]>`
    INSERT INTO vendors (company_id, display_name)
    VALUES (${fx.companyId}, ${vendorName}) RETURNING id
  `;
  const [ap] = await sql<{ id: string }[]>`
    INSERT INTO accounts (company_id, code, name, type, subtype)
    VALUES (${fx.companyId}, '2000', 'Accounts Payable', 'liability', 'accounts_payable')
    RETURNING id
  `;
  return { vendorId: vendor!.id, apAccountId: ap!.id };
}

describeIfDb('bills', () => {
  let fxA: Awaited<ReturnType<typeof createTestCompany>> | null = null;
  let fxB: Awaited<ReturnType<typeof createTestCompany>> | null = null;
  let bFxA: BillFixture | null = null;
  let bFxB: BillFixture | null = null;

  afterAll(async () => {
    if (fxA) await dropTestCompany(fxA.companyId);
    if (fxB) await dropTestCompany(fxB.companyId);
  });

  it('inserts a bill + lines + a balanced journal entry in one transaction', async () => {
    fxA ??= await createTestCompany('bill_a');
    bFxA ??= await seedVendorAndAp(fxA, 'Office Supply Co');

    const result = await withCompanyTx(fxA, 'owner', async (tx) => {
      const [entry] = await tx<{ id: string }[]>`
        INSERT INTO journal_entries (company_id, entry_date, source_type, created_by, memo)
        VALUES (${fxA!.companyId}, '2026-01-20', 'bill', ${fxA!.userId}, 'Bill BILL-1001')
        RETURNING id
      `;
      const entryId = entry!.id;

      // DR Expense 75.00, CR A/P 75.00
      await tx`
        INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit, currency, fx_rate)
        VALUES
          (${entryId}, ${fxA!.companyId}, ${fxA!.expenseAccountId}, '75.0000', '0', 'USD', '1'),
          (${entryId}, ${fxA!.companyId}, ${bFxA!.apAccountId}, '0', '75.0000', 'USD', '1')
      `;

      const [b] = await tx<{ id: string }[]>`
        INSERT INTO bills (
          company_id, vendor_id, bill_number, bill_date, due_date,
          status, subtotal, tax_amount, total, balance_due, posted_journal_entry_id
        )
        VALUES (
          ${fxA!.companyId}, ${bFxA!.vendorId}, 'BILL-1001', '2026-01-20', '2026-02-19',
          'open', '75.0000', '0.0000', '75.0000', '75.0000', ${entryId}
        )
        RETURNING id
      `;
      const billId = b!.id;

      await tx`
        INSERT INTO bill_lines (bill_id, company_id, line_number, account_id, description, quantity, unit_price, amount)
        VALUES (${billId}, ${fxA!.companyId}, 1, ${fxA!.expenseAccountId}, 'Stationery', '1', '75.0000', '75.0000')
      `;

      return { billId, entryId };
    });

    expect(result.billId).toBeDefined();

    const balances = await withCompanyTx(fxA, 'owner', async (tx) => {
      return tx<{ account_id: string; debit: string; credit: string }[]>`
        SELECT account_id, COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
        FROM journal_lines
        WHERE entry_id = ${result.entryId}
        GROUP BY account_id
      `;
    });
    const totalDebit = balances.reduce((acc, r) => acc + Number(r.debit), 0);
    const totalCredit = balances.reduce((acc, r) => acc + Number(r.credit), 0);
    expect(totalDebit).toBe(75);
    expect(totalCredit).toBe(75);
  });

  it('rejects edits to most bill columns after posting (lock trigger)', async () => {
    fxA ??= await createTestCompany('bill_a');
    bFxA ??= await seedVendorAndAp(fxA, 'Office Supply Co');

    const [existing] = await withCompanyTx(fxA, 'owner', async (tx) =>
      tx<{ id: string }[]>`SELECT id FROM bills WHERE bill_number = 'BILL-1001' LIMIT 1`,
    );
    expect(existing).toBeDefined();
    const billId = existing!.id;

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`UPDATE bills SET memo = 'tampered' WHERE id = ${billId}`;
      }),
    ).rejects.toThrow(/locked/i);

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`UPDATE bills SET bill_number = 'FAKE-1' WHERE id = ${billId}`;
      }),
    ).rejects.toThrow(/locked/i);

    // balance_due is allowed to change (will be exercised by payments).
    await withCompanyTx(fxA, 'owner', async (tx) => {
      await tx`UPDATE bills SET balance_due = '50.0000' WHERE id = ${billId}`;
    });
    await withCompanyTx(fxA, 'owner', async (tx) => {
      await tx`UPDATE bills SET balance_due = '75.0000' WHERE id = ${billId}`;
    });
  });

  it('rejects DELETE on bills and bill_lines', async () => {
    fxA ??= await createTestCompany('bill_a');
    bFxA ??= await seedVendorAndAp(fxA, 'Office Supply Co');

    const [existing] = await withCompanyTx(fxA, 'owner', async (tx) =>
      tx<{ id: string }[]>`SELECT id FROM bills WHERE bill_number = 'BILL-1001' LIMIT 1`,
    );
    const billId = existing!.id;

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`DELETE FROM bills WHERE id = ${billId}`;
      }),
    ).rejects.toThrow(/cannot be deleted/i);

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`DELETE FROM bill_lines WHERE bill_id = ${billId}`;
      }),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('isolates bills across companies (RLS)', async () => {
    fxA ??= await createTestCompany('bill_a');
    fxB ??= await createTestCompany('bill_b');
    bFxA ??= await seedVendorAndAp(fxA, 'Office Supply Co');
    bFxB ??= await seedVendorAndAp(fxB, 'Beta Supply');

    await withCompanyTx(fxB, 'owner', async (tx) => {
      const [entry] = await tx<{ id: string }[]>`
        INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
        VALUES (${fxB!.companyId}, '2026-01-25', 'bill', ${fxB!.userId})
        RETURNING id
      `;
      const entryId = entry!.id;
      await tx`
        INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit, currency, fx_rate)
        VALUES
          (${entryId}, ${fxB!.companyId}, ${fxB!.expenseAccountId}, '12.0000', '0', 'USD', '1'),
          (${entryId}, ${fxB!.companyId}, ${bFxB!.apAccountId}, '0', '12.0000', 'USD', '1')
      `;
      await tx`
        INSERT INTO bills (company_id, vendor_id, bill_number, bill_date, due_date,
                           status, subtotal, tax_amount, total, balance_due, posted_journal_entry_id)
        VALUES (${fxB!.companyId}, ${bFxB!.vendorId}, 'B-BILL-1', '2026-01-25', '2026-01-25',
                'open', '12.0000', '0.0000', '12.0000', '12.0000', ${entryId})
      `;
    });

    const fromA = await withCompanyTx(fxA, 'owner', async (tx) =>
      tx<{ bill_number: string }[]>`SELECT bill_number FROM bills`,
    );
    const fromB = await withCompanyTx(fxB, 'owner', async (tx) =>
      tx<{ bill_number: string }[]>`SELECT bill_number FROM bills`,
    );

    expect(fromA.map((r) => r.bill_number)).toContain('BILL-1001');
    expect(fromA.map((r) => r.bill_number)).not.toContain('B-BILL-1');
    expect(fromB.map((r) => r.bill_number)).toContain('B-BILL-1');
    expect(fromB.map((r) => r.bill_number)).not.toContain('BILL-1001');
  });

  it('enforces unique (company_id, bill_number)', async () => {
    fxA ??= await createTestCompany('bill_a');
    bFxA ??= await seedVendorAndAp(fxA, 'Office Supply Co');

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        const [entry] = await tx<{ id: string }[]>`
          INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
          VALUES (${fxA!.companyId}, '2026-01-20', 'bill', ${fxA!.userId})
          RETURNING id
        `;
        const entryId = entry!.id;
        await tx`
          INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit, currency, fx_rate)
          VALUES
            (${entryId}, ${fxA!.companyId}, ${fxA!.expenseAccountId}, '1.0000', '0', 'USD', '1'),
            (${entryId}, ${fxA!.companyId}, ${bFxA!.apAccountId}, '0', '1.0000', 'USD', '1')
        `;
        await tx`
          INSERT INTO bills (company_id, vendor_id, bill_number, bill_date, due_date,
                             status, subtotal, tax_amount, total, balance_due, posted_journal_entry_id)
          VALUES (${fxA!.companyId}, ${bFxA!.vendorId}, 'BILL-1001', '2026-01-20', '2026-01-20',
                  'open', '1.0000', '0.0000', '1.0000', '1.0000', ${entryId})
        `;
      }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
