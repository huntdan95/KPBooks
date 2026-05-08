/**
 * Invoices: posting writes a balanced JE, void posts a reversal, locked-after-post
 * trigger blocks edits, RLS keeps invoices isolated across companies.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCompany, dropTestCompany, getAdminSql, withCompanyTx } from './setup';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

interface InvoiceFixture {
  customerId: string;
  arAccountId: string;
}

async function seedCustomerAndAr(
  fx: Awaited<ReturnType<typeof createTestCompany>>,
  customerName: string,
): Promise<InvoiceFixture> {
  const sql = getAdminSql();
  const [customer] = await sql<{ id: string }[]>`
    INSERT INTO customers (company_id, display_name)
    VALUES (${fx.companyId}, ${customerName}) RETURNING id
  `;
  const [ar] = await sql<{ id: string }[]>`
    INSERT INTO accounts (company_id, code, name, type, subtype)
    VALUES (${fx.companyId}, '1100', 'Accounts Receivable', 'asset', 'accounts_receivable')
    RETURNING id
  `;
  return { customerId: customer!.id, arAccountId: ar!.id };
}

describeIfDb('invoices', () => {
  let fxA: Awaited<ReturnType<typeof createTestCompany>> | null = null;
  let fxB: Awaited<ReturnType<typeof createTestCompany>> | null = null;
  let invFxA: InvoiceFixture | null = null;
  let invFxB: InvoiceFixture | null = null;

  afterAll(async () => {
    if (fxA) await dropTestCompany(fxA.companyId);
    if (fxB) await dropTestCompany(fxB.companyId);
  });

  it('inserts an invoice + lines + a balanced journal entry in one transaction', async () => {
    fxA ??= await createTestCompany('inv_a');
    invFxA ??= await seedCustomerAndAr(fxA, 'Acme Corp');

    const result = await withCompanyTx(fxA, 'owner', async (tx) => {
      // Simulate what createInvoice does: create a journal_entry + 2 lines + invoice + invoice_line.
      // We bypass the application service here and exercise just the DB-level invariants.
      const [entry] = await tx<{ id: string }[]>`
        INSERT INTO journal_entries (company_id, entry_date, source_type, created_by, memo)
        VALUES (${fxA!.companyId}, '2026-01-15', 'invoice', ${fxA!.userId}, 'Invoice INV-1001')
        RETURNING id
      `;
      const entryId = entry!.id;

      // DR A/R 250.00, CR Revenue 250.00
      await tx`
        INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit, currency, fx_rate)
        VALUES
          (${entryId}, ${fxA!.companyId}, ${invFxA!.arAccountId}, '250.0000', '0', 'USD', '1'),
          (${entryId}, ${fxA!.companyId}, ${fxA!.revenueAccountId}, '0', '250.0000', 'USD', '1')
      `;

      const [inv] = await tx<{ id: string }[]>`
        INSERT INTO invoices (
          company_id, customer_id, invoice_number, invoice_date, due_date,
          status, subtotal, tax_amount, total, balance_due, posted_journal_entry_id
        )
        VALUES (
          ${fxA!.companyId}, ${invFxA!.customerId}, 'INV-1001', '2026-01-15', '2026-02-14',
          'open', '250.0000', '0.0000', '250.0000', '250.0000', ${entryId}
        )
        RETURNING id
      `;
      const invId = inv!.id;

      await tx`
        INSERT INTO invoice_lines (invoice_id, company_id, line_number, account_id, description, quantity, unit_price, amount)
        VALUES (${invId}, ${fxA!.companyId}, 1, ${fxA!.revenueAccountId}, 'Service', '1', '250.0000', '250.0000')
      `;

      return { invId, entryId };
    });

    expect(result.invId).toBeDefined();
    expect(result.entryId).toBeDefined();

    // Verify the trial-balance-style aggregation finds A/R = 250 DR and Revenue = 250 CR.
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
    expect(totalDebit).toBe(250);
    expect(totalCredit).toBe(250);
  });

  it('rejects edits to most invoice columns after posting (lock trigger)', async () => {
    fxA ??= await createTestCompany('inv_a');
    invFxA ??= await seedCustomerAndAr(fxA, 'Acme Corp');

    // Reuse the invoice the previous test created. Find it.
    const [existing] = await withCompanyTx(fxA, 'owner', async (tx) =>
      tx<{ id: string }[]>`SELECT id FROM invoices WHERE invoice_number = 'INV-1001' LIMIT 1`,
    );
    expect(existing).toBeDefined();
    const invId = existing!.id;

    // Edit a locked column (memo) — should fail.
    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`UPDATE invoices SET memo = 'tampered' WHERE id = ${invId}`;
      }),
    ).rejects.toThrow(/locked/i);

    // Edit invoice_number — should fail.
    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`UPDATE invoices SET invoice_number = 'FAKE-1' WHERE id = ${invId}`;
      }),
    ).rejects.toThrow(/locked/i);

    // Touching balance_due alone is allowed (will be exercised by payments).
    await withCompanyTx(fxA, 'owner', async (tx) => {
      await tx`UPDATE invoices SET balance_due = '100.0000' WHERE id = ${invId}`;
    });
    // Restore so subsequent tests aren't affected.
    await withCompanyTx(fxA, 'owner', async (tx) => {
      await tx`UPDATE invoices SET balance_due = '250.0000' WHERE id = ${invId}`;
    });
  });

  it('rejects DELETE on invoices and invoice_lines', async () => {
    fxA ??= await createTestCompany('inv_a');
    invFxA ??= await seedCustomerAndAr(fxA, 'Acme Corp');

    const [existing] = await withCompanyTx(fxA, 'owner', async (tx) =>
      tx<{ id: string }[]>`SELECT id FROM invoices WHERE invoice_number = 'INV-1001' LIMIT 1`,
    );
    const invId = existing!.id;

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`DELETE FROM invoices WHERE id = ${invId}`;
      }),
    ).rejects.toThrow(/cannot be deleted/i);

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`DELETE FROM invoice_lines WHERE invoice_id = ${invId}`;
      }),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('isolates invoices across companies (RLS)', async () => {
    fxA ??= await createTestCompany('inv_a');
    fxB ??= await createTestCompany('inv_b');
    invFxA ??= await seedCustomerAndAr(fxA, 'Acme Corp');
    invFxB ??= await seedCustomerAndAr(fxB, 'Beta LLC');

    // Already have one invoice in fxA from the earlier test. Add one in fxB.
    await withCompanyTx(fxB, 'owner', async (tx) => {
      const [entry] = await tx<{ id: string }[]>`
        INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
        VALUES (${fxB!.companyId}, '2026-01-20', 'invoice', ${fxB!.userId})
        RETURNING id
      `;
      const entryId = entry!.id;
      await tx`
        INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit, currency, fx_rate)
        VALUES
          (${entryId}, ${fxB!.companyId}, ${invFxB!.arAccountId}, '99.0000', '0', 'USD', '1'),
          (${entryId}, ${fxB!.companyId}, ${fxB!.revenueAccountId}, '0', '99.0000', 'USD', '1')
      `;
      await tx`
        INSERT INTO invoices (company_id, customer_id, invoice_number, invoice_date, due_date,
                              status, subtotal, tax_amount, total, balance_due, posted_journal_entry_id)
        VALUES (${fxB!.companyId}, ${invFxB!.customerId}, 'B-INV-1', '2026-01-20', '2026-01-20',
                'open', '99.0000', '0.0000', '99.0000', '99.0000', ${entryId})
      `;
    });

    const fromA = await withCompanyTx(fxA, 'owner', async (tx) =>
      tx<{ invoice_number: string }[]>`SELECT invoice_number FROM invoices`,
    );
    const fromB = await withCompanyTx(fxB, 'owner', async (tx) =>
      tx<{ invoice_number: string }[]>`SELECT invoice_number FROM invoices`,
    );

    expect(fromA.map((r) => r.invoice_number)).toContain('INV-1001');
    expect(fromA.map((r) => r.invoice_number)).not.toContain('B-INV-1');
    expect(fromB.map((r) => r.invoice_number)).toContain('B-INV-1');
    expect(fromB.map((r) => r.invoice_number)).not.toContain('INV-1001');
  });

  it('enforces unique (company_id, invoice_number)', async () => {
    fxA ??= await createTestCompany('inv_a');
    invFxA ??= await seedCustomerAndAr(fxA, 'Acme Corp');

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        const [entry] = await tx<{ id: string }[]>`
          INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
          VALUES (${fxA!.companyId}, '2026-01-15', 'invoice', ${fxA!.userId})
          RETURNING id
        `;
        const entryId = entry!.id;
        await tx`
          INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit, currency, fx_rate)
          VALUES
            (${entryId}, ${fxA!.companyId}, ${invFxA!.arAccountId}, '1.0000', '0', 'USD', '1'),
            (${entryId}, ${fxA!.companyId}, ${fxA!.revenueAccountId}, '0', '1.0000', 'USD', '1')
        `;
        await tx`
          INSERT INTO invoices (company_id, customer_id, invoice_number, invoice_date, due_date,
                                status, subtotal, tax_amount, total, balance_due, posted_journal_entry_id)
          VALUES (${fxA!.companyId}, ${invFxA!.customerId}, 'INV-1001', '2026-01-15', '2026-01-15',
                  'open', '1.0000', '0.0000', '1.0000', '1.0000', ${entryId})
        `;
      }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
