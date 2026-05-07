/**
 * Closed-period guard: once a company sets closed_through_date, posting on or
 * before that date is rejected — unless an admin opts in via the
 * app.allow_closed_period GUC, in which case it succeeds (and the caller is
 * expected to log the override; we just verify the gate works).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCompany, dropTestCompany, getAdminSql, withCompanyTx } from './setup';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('closed-period guard', () => {
  let fx: Awaited<ReturnType<typeof createTestCompany>> | null = null;

  afterAll(async () => {
    if (fx) await dropTestCompany(fx.companyId);
  });

  it('blocks posting on/before closed_through_date by default', async () => {
    fx = await createTestCompany('closed');

    const sql = getAdminSql();
    await sql`UPDATE companies SET closed_through_date = '2025-12-31' WHERE id = ${fx.companyId}`;

    // Posting in the closed period — must fail.
    await expect(
      withCompanyTx(fx, 'owner', async (tx) => {
        await tx`
          INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
          VALUES (${fx!.companyId}, '2025-12-01', 'manual', ${fx!.userId})
        `;
      }),
    ).rejects.toThrow(/closed period/i);

    // Posting after — succeeds.
    await withCompanyTx(fx, 'owner', async (tx) => {
      const [entry] = await tx<{ id: string }[]>`
        INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
        VALUES (${fx!.companyId}, '2026-01-15', 'manual', ${fx!.userId}) RETURNING id
      `;
      await tx`
        INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
        VALUES
          (${entry!.id}, ${fx!.companyId}, ${fx!.cashAccountId}, '10.0000', '0'),
          (${entry!.id}, ${fx!.companyId}, ${fx!.revenueAccountId}, '0', '10.0000')
      `;
    });
  });

  it('admin override allows posting in closed period', async () => {
    fx ??= await createTestCompany('closed');
    const sql = getAdminSql();
    await sql`UPDATE companies SET closed_through_date = '2025-12-31' WHERE id = ${fx.companyId}`;

    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_company', ${fx!.companyId}, true)`;
      await tx`SELECT set_config('app.current_user', ${fx!.userId}, true)`;
      await tx`SELECT set_config('app.current_role', 'admin', true)`;
      await tx`SELECT set_config('app.allow_closed_period', 'true', true)`;
      const [entry] = await tx<{ id: string }[]>`
        INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
        VALUES (${fx!.companyId}, '2025-12-01', 'manual', ${fx!.userId}) RETURNING id
      `;
      await tx`
        INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
        VALUES
          (${entry!.id}, ${fx!.companyId}, ${fx!.cashAccountId}, '5.0000', '0'),
          (${entry!.id}, ${fx!.companyId}, ${fx!.revenueAccountId}, '0', '5.0000')
      `;
    });
  });

  it('non-admin override is still rejected', async () => {
    fx ??= await createTestCompany('closed');
    const sql = getAdminSql();
    await sql`UPDATE companies SET closed_through_date = '2025-12-31' WHERE id = ${fx.companyId}`;

    await expect(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_company', ${fx!.companyId}, true)`;
        await tx`SELECT set_config('app.current_user', ${fx!.userId}, true)`;
        await tx`SELECT set_config('app.current_role', 'bookkeeper', true)`;
        await tx`SELECT set_config('app.allow_closed_period', 'true', true)`;
        await tx`
          INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
          VALUES (${fx!.companyId}, '2025-12-01', 'manual', ${fx!.userId})
        `;
      }),
    ).rejects.toThrow(/closed period/i);
  });
});
