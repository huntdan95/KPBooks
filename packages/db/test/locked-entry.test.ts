/**
 * Locked entries are immutable. The only legal way to "edit" a posted entry
 * is to reverse it. These tests cover the BEFORE triggers on journal_entries
 * and journal_lines that block mutations once `locked = true`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCompany, dropTestCompany, getSql, withCompanyTx } from './setup';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function postSimpleEntry(
  fx: Awaited<ReturnType<typeof createTestCompany>>,
): Promise<string> {
  return withCompanyTx(fx, 'owner', async (tx) => {
    const [entry] = await tx<{ id: string }[]>`
      INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
      VALUES (${fx.companyId}, '2026-02-01', 'manual', ${fx.userId}) RETURNING id
    `;
    await tx`
      INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
      VALUES
        (${entry!.id}, ${fx.companyId}, ${fx.cashAccountId}, '25.0000', '0'),
        (${entry!.id}, ${fx.companyId}, ${fx.revenueAccountId}, '0', '25.0000')
    `;
    return entry!.id;
  });
}

describeIfDb('locked entries are immutable', () => {
  let fx: Awaited<ReturnType<typeof createTestCompany>> | null = null;

  afterAll(async () => {
    if (fx) await dropTestCompany(fx.companyId);
  });

  it('locking flag itself can be set; subsequent edits are rejected', async () => {
    fx = await createTestCompany('locked');
    const entryId = await postSimpleEntry(fx);

    // Lock it.
    await withCompanyTx(fx, 'owner', async (tx) => {
      await tx`UPDATE journal_entries SET locked = true WHERE id = ${entryId}`;
    });

    // Try to change the memo — should fail.
    await expect(
      withCompanyTx(fx, 'owner', async (tx) => {
        await tx`UPDATE journal_entries SET memo = 'sneaky edit' WHERE id = ${entryId}`;
      }),
    ).rejects.toThrow(/locked/i);

    // Try to change a line's debit — should fail.
    await expect(
      withCompanyTx(fx, 'owner', async (tx) => {
        await tx`UPDATE journal_lines SET debit = '99.9999' WHERE entry_id = ${entryId}`;
      }),
    ).rejects.toThrow(/locked/i);

    // Try to delete a line — should fail.
    await expect(
      withCompanyTx(fx, 'owner', async (tx) => {
        await tx`DELETE FROM journal_lines WHERE entry_id = ${entryId}`;
      }),
    ).rejects.toThrow(/locked/i);

    // Delete of the entry itself — should fail.
    await expect(
      withCompanyTx(fx, 'owner', async (tx) => {
        await tx`DELETE FROM journal_entries WHERE id = ${entryId}`;
      }),
    ).rejects.toThrow(/locked/i);
  });

  it('unlocked entries can be edited normally', async () => {
    fx ??= await createTestCompany('locked');
    const entryId = await postSimpleEntry(fx);

    // Memo edit on an unlocked entry succeeds.
    await withCompanyTx(fx, 'owner', async (tx) => {
      await tx`UPDATE journal_entries SET memo = 'normal edit' WHERE id = ${entryId}`;
    });
    const sql = getSql();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_company', ${fx!.companyId}, true)`;
      const [row] = await tx<{ memo: string }[]>`
        SELECT memo FROM journal_entries WHERE id = ${entryId}
      `;
      expect(row!.memo).toBe('normal edit');
    });
  });
});
