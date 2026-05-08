/**
 * Customers + vendors: RLS isolation, basic CRUD, and the partial-unique index
 * on (company_id, account_number) where account_number IS NOT NULL.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCompany, dropTestCompany, withCompanyTx } from './setup';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('customers + vendors', () => {
  let fxA: Awaited<ReturnType<typeof createTestCompany>> | null = null;
  let fxB: Awaited<ReturnType<typeof createTestCompany>> | null = null;

  afterAll(async () => {
    if (fxA) await dropTestCompany(fxA.companyId);
    if (fxB) await dropTestCompany(fxB.companyId);
  });

  it('inserts and reads a customer scoped to current_company', async () => {
    fxA ??= await createTestCompany('cv_a');

    const created = await withCompanyTx(fxA, 'owner', async (tx) => {
      const [row] = await tx<{ id: string; display_name: string }[]>`
        INSERT INTO customers (company_id, display_name, email)
        VALUES (${fxA!.companyId}, 'Acme Corp', 'ap@acme.com')
        RETURNING id, display_name
      `;
      return row!;
    });
    expect(created.display_name).toBe('Acme Corp');

    const read = await withCompanyTx(fxA, 'owner', async (tx) => {
      return tx<{ id: string }[]>`SELECT id FROM customers WHERE id = ${created.id}`;
    });
    expect(read.length).toBe(1);
  });

  it('inserts and reads a vendor scoped to current_company', async () => {
    fxA ??= await createTestCompany('cv_a');

    const created = await withCompanyTx(fxA, 'owner', async (tx) => {
      const [row] = await tx<{ id: string; display_name: string; is_1099_vendor: boolean }[]>`
        INSERT INTO vendors (company_id, display_name, is_1099_vendor, tax_id)
        VALUES (${fxA!.companyId}, 'Office Supply Co', true, '12-3456789')
        RETURNING id, display_name, is_1099_vendor
      `;
      return row!;
    });
    expect(created.display_name).toBe('Office Supply Co');
    expect(created.is_1099_vendor).toBe(true);
  });

  it('isolates customers/vendors between companies (RLS)', async () => {
    fxA ??= await createTestCompany('cv_a');
    fxB ??= await createTestCompany('cv_b');

    // Seed one customer + one vendor in each company.
    await withCompanyTx(fxA, 'owner', async (tx) => {
      await tx`INSERT INTO customers (company_id, display_name) VALUES (${fxA!.companyId}, 'A-cust')`;
      await tx`INSERT INTO vendors   (company_id, display_name) VALUES (${fxA!.companyId}, 'A-vend')`;
    });
    await withCompanyTx(fxB, 'owner', async (tx) => {
      await tx`INSERT INTO customers (company_id, display_name) VALUES (${fxB!.companyId}, 'B-cust')`;
      await tx`INSERT INTO vendors   (company_id, display_name) VALUES (${fxB!.companyId}, 'B-vend')`;
    });

    const aCustomers = await withCompanyTx(fxA, 'owner', async (tx) =>
      tx<{ display_name: string }[]>`SELECT display_name FROM customers`,
    );
    const aVendors = await withCompanyTx(fxA, 'owner', async (tx) =>
      tx<{ display_name: string }[]>`SELECT display_name FROM vendors`,
    );
    expect(aCustomers.map((r) => r.display_name)).not.toContain('B-cust');
    expect(aVendors.map((r) => r.display_name)).not.toContain('B-vend');
    expect(aCustomers.map((r) => r.display_name)).toContain('A-cust');
    expect(aVendors.map((r) => r.display_name)).toContain('A-vend');
  });

  it('rejects inserts for a different company (RLS WITH CHECK)', async () => {
    fxA ??= await createTestCompany('cv_a');
    fxB ??= await createTestCompany('cv_b');

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`
          INSERT INTO customers (company_id, display_name)
          VALUES (${fxB!.companyId}, 'sneaky')
        `;
      }),
    ).rejects.toThrow();

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`
          INSERT INTO vendors (company_id, display_name)
          VALUES (${fxB!.companyId}, 'sneaky')
        `;
      }),
    ).rejects.toThrow();
  });

  it('enforces unique account_number per company when set', async () => {
    fxA ??= await createTestCompany('cv_a');

    await withCompanyTx(fxA, 'owner', async (tx) => {
      await tx`
        INSERT INTO customers (company_id, display_name, account_number)
        VALUES (${fxA!.companyId}, 'First', 'C-100')
      `;
    });

    // Same account_number in same company → violates unique index.
    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`
          INSERT INTO customers (company_id, display_name, account_number)
          VALUES (${fxA!.companyId}, 'Second', 'C-100')
        `;
      }),
    ).rejects.toThrow(/duplicate key|unique/i);

    // Two NULLs are fine — partial unique index only covers non-null values.
    await withCompanyTx(fxA, 'owner', async (tx) => {
      await tx`INSERT INTO customers (company_id, display_name) VALUES (${fxA!.companyId}, 'NoNumA')`;
      await tx`INSERT INTO customers (company_id, display_name) VALUES (${fxA!.companyId}, 'NoNumB')`;
    });
  });

  it('touch_updated_at fires on customer update', async () => {
    fxA ??= await createTestCompany('cv_a');

    const id = await withCompanyTx(fxA, 'owner', async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO customers (company_id, display_name)
        VALUES (${fxA!.companyId}, 'TouchTest') RETURNING id
      `;
      return row!.id;
    });

    const before = await withCompanyTx(fxA, 'owner', async (tx) => {
      const [row] = await tx<{ updated_at: Date }[]>`
        SELECT updated_at FROM customers WHERE id = ${id}
      `;
      return row!.updated_at;
    });

    // Wait long enough that NOW() will tick — Postgres timestamp resolution is microseconds.
    await new Promise((r) => setTimeout(r, 50));

    const after = await withCompanyTx(fxA, 'owner', async (tx) => {
      await tx`UPDATE customers SET display_name = 'Renamed' WHERE id = ${id}`;
      const [row] = await tx<{ updated_at: Date }[]>`
        SELECT updated_at FROM customers WHERE id = ${id}
      `;
      return row!.updated_at;
    });

    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});
