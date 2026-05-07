/**
 * Row-level security: forgetting `WHERE company_id = ?` in app code must not
 * leak another company's data. The RLS policies are the safety net.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCompany, dropTestCompany, getSql, withCompanyTx } from './setup';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('row-level security', () => {
  let fxA: Awaited<ReturnType<typeof createTestCompany>> | null = null;
  let fxB: Awaited<ReturnType<typeof createTestCompany>> | null = null;

  afterAll(async () => {
    if (fxA) await dropTestCompany(fxA.companyId);
    if (fxB) await dropTestCompany(fxB.companyId);
  });

  it('reads scoped to current_company only', async () => {
    fxA ??= await createTestCompany('rls_a');
    fxB ??= await createTestCompany('rls_b');

    // Each company has 3 accounts (cash, revenue, expense). Reading from A's
    // GUC must show only A's accounts.
    const fromA = await withCompanyTx(fxA, 'owner', async (tx) => {
      return tx<{ id: string }[]>`SELECT id FROM accounts`;
    });
    expect(fromA.length).toBe(3);
    expect(fromA.map((r) => r.id).sort()).toEqual(
      [fxA.cashAccountId, fxA.revenueAccountId, fxA.expenseAccountId].sort(),
    );

    const fromB = await withCompanyTx(fxB, 'owner', async (tx) => {
      return tx<{ id: string }[]>`SELECT id FROM accounts`;
    });
    expect(fromB.length).toBe(3);
    expect(fromB.map((r) => r.id).sort()).toEqual(
      [fxB.cashAccountId, fxB.revenueAccountId, fxB.expenseAccountId].sort(),
    );

    // No bleed: A's set and B's set are disjoint.
    const aSet = new Set(fromA.map((r) => r.id));
    const bSet = new Set(fromB.map((r) => r.id));
    for (const id of bSet) expect(aSet.has(id)).toBe(false);
  });

  it('writes blocked when company_id mismatches current_company', async () => {
    fxA ??= await createTestCompany('rls_a');
    fxB ??= await createTestCompany('rls_b');

    // Acting as A, attempt to insert an account assigned to company B.
    // The WITH CHECK clause should reject it.
    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`
          INSERT INTO accounts (company_id, code, name, type, subtype)
          VALUES (${fxB!.companyId}, '9999', 'Sneaky', 'asset', 'bank')
        `;
      }),
    ).rejects.toThrow();
  });

  it('without GUC set, all reads return zero rows (fail-closed)', async () => {
    fxA ??= await createTestCompany('rls_a');
    const sql = getSql();
    // Default session has no app.current_company; RLS should hide everything.
    const rows = await sql<{ id: string }[]>`SELECT id FROM accounts WHERE id = ${fxA.cashAccountId}`;
    expect(rows.length).toBe(0);
  });
});
