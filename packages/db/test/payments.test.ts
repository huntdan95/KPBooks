/**
 * Payments: lock-after-post, RLS, CHECK constraints (counterparty, positive amount,
 * target XOR on payment_applications). Application-level logic (sum of applications =
 * amount, balance/status updates, void restoration) is exercised in the
 * payments/posting.service tests once we add API-level tests.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCompany, dropTestCompany, getAdminSql, withCompanyTx } from './setup';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

interface PayFixtureA {
  customerId: string;
  arAccountId: string;
  bankAccountId: string;
  invoiceJEId: string;
  paymentId: string;
}

/**
 * Atomically seed a customer + A/R + bank + a posted $200 invoice + a posted
 * $50 partial payment with one application. Single sql.begin() so the
 * deferred journal_entries_min_lines trigger sees the lines at COMMIT.
 */
async function seedReceivableFixture(
  fx: Awaited<ReturnType<typeof createTestCompany>>,
): Promise<PayFixtureA> {
  const sql = getAdminSql();
  return await sql.begin<PayFixtureA>(async (tx) => {
    const [customer] = await tx<{ id: string }[]>`
      INSERT INTO customers (company_id, display_name)
      VALUES (${fx.companyId}, 'Acme Corp') RETURNING id
    `;
    const [ar] = await tx<{ id: string }[]>`
      INSERT INTO accounts (company_id, code, name, type, subtype)
      VALUES (${fx.companyId}, '1100', 'Accounts Receivable', 'asset', 'accounts_receivable')
      RETURNING id
    `;
    const [bank] = await tx<{ id: string }[]>`
      INSERT INTO accounts (company_id, code, name, type, subtype)
      VALUES (${fx.companyId}, '1010', 'Checking', 'asset', 'bank')
      RETURNING id
    `;

    // Invoice JE: DR A/R 200, CR Revenue 200.
    const [invEntry] = await tx<{ id: string }[]>`
      INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
      VALUES (${fx.companyId}, '2026-02-01', 'invoice', ${fx.userId})
      RETURNING id
    `;
    const invEntryId = invEntry!.id;
    await tx`
      INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit, currency, fx_rate)
      VALUES
        (${invEntryId}, ${fx.companyId}, ${ar!.id}, '200.0000', '0', 'USD', '1'),
        (${invEntryId}, ${fx.companyId}, ${fx.revenueAccountId}, '0', '200.0000', 'USD', '1')
    `;

    const [inv] = await tx<{ id: string }[]>`
      INSERT INTO invoices (company_id, customer_id, invoice_number, invoice_date, due_date,
                            status, subtotal, tax_amount, total, balance_due, posted_journal_entry_id)
      VALUES (${fx.companyId}, ${customer!.id}, 'INV-PAY-1', '2026-02-01', '2026-03-03',
              'open', '200.0000', '0.0000', '200.0000', '200.0000', ${invEntryId})
      RETURNING id
    `;
    const invoiceId = inv!.id;

    // Payment JE: DR Bank 50, CR A/R 50 -> partial payment.
    const [payEntry] = await tx<{ id: string }[]>`
      INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
      VALUES (${fx.companyId}, '2026-02-10', 'payment', ${fx.userId})
      RETURNING id
    `;
    const payEntryId = payEntry!.id;
    await tx`
      INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit, currency, fx_rate)
      VALUES
        (${payEntryId}, ${fx.companyId}, ${bank!.id}, '50.0000', '0', 'USD', '1'),
        (${payEntryId}, ${fx.companyId}, ${ar!.id}, '0', '50.0000', 'USD', '1')
    `;

    const [pay] = await tx<{ id: string }[]>`
      INSERT INTO payments (company_id, payment_type, customer_id, payment_date, payment_method,
                            bank_account_id, amount, status, posted_journal_entry_id)
      VALUES (${fx.companyId}, 'customer_received', ${customer!.id}, '2026-02-10', 'check',
              ${bank!.id}, '50.0000', 'posted', ${payEntryId})
      RETURNING id
    `;
    const paymentId = pay!.id;
    await tx`
      INSERT INTO payment_applications (payment_id, company_id, invoice_id, amount)
      VALUES (${paymentId}, ${fx.companyId}, ${invoiceId}, '50.0000')
    `;

    // Reflect the partial application on the invoice.
    await tx`
      UPDATE invoices SET balance_due = '150.0000', status = 'partial' WHERE id = ${invoiceId}
    `;

    return {
      customerId: customer!.id,
      arAccountId: ar!.id,
      bankAccountId: bank!.id,
      invoiceJEId: invEntryId,
      paymentId,
    };
  });
}

describeIfDb('payments', () => {
  let fxA: Awaited<ReturnType<typeof createTestCompany>> | null = null;
  let pFxA: PayFixtureA | null = null;

  afterAll(async () => {
    if (fxA) await dropTestCompany(fxA.companyId);
  });

  it('seeds a payment + application linked to a partial invoice', async () => {
    fxA ??= await createTestCompany('pay_a');
    pFxA ??= await seedReceivableFixture(fxA);

    const inv = await withCompanyTx(fxA, 'owner', async (tx) => {
      const [r] = await tx<{ status: string; balance_due: string }[]>`
        SELECT status, balance_due FROM invoices WHERE invoice_number = 'INV-PAY-1'
      `;
      return r!;
    });
    expect(inv.status).toBe('partial');
    expect(Number(inv.balance_due)).toBe(150);

    const apps = await withCompanyTx(fxA, 'owner', async (tx) =>
      tx<{ amount: string }[]>`SELECT amount FROM payment_applications WHERE payment_id = ${pFxA!.paymentId}`,
    );
    expect(apps).toHaveLength(1);
    expect(Number(apps[0]!.amount)).toBe(50);
  });

  it('lock trigger blocks edits to a posted payment (memo, amount)', async () => {
    fxA ??= await createTestCompany('pay_a');
    pFxA ??= await seedReceivableFixture(fxA);

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`UPDATE payments SET memo = 'tampered' WHERE id = ${pFxA!.paymentId}`;
      }),
    ).rejects.toThrow(/locked/i);

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`UPDATE payments SET amount = '999.0000' WHERE id = ${pFxA!.paymentId}`;
      }),
    ).rejects.toThrow(/locked/i);
  });

  it('rejects DELETE on payments and payment_applications', async () => {
    fxA ??= await createTestCompany('pay_a');
    pFxA ??= await seedReceivableFixture(fxA);

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`DELETE FROM payments WHERE id = ${pFxA!.paymentId}`;
      }),
    ).rejects.toThrow(/cannot be deleted/i);

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`DELETE FROM payment_applications WHERE payment_id = ${pFxA!.paymentId}`;
      }),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('counterparty CHECK rejects customer_received with a vendorId set', async () => {
    fxA ??= await createTestCompany('pay_a');
    pFxA ??= await seedReceivableFixture(fxA);

    const sql = getAdminSql();
    const [vendor] = await sql<{ id: string }[]>`
      INSERT INTO vendors (company_id, display_name) VALUES (${fxA.companyId}, 'OopsVendor') RETURNING id
    `;

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`
          INSERT INTO payments (company_id, payment_type, customer_id, vendor_id,
                                payment_date, payment_method, bank_account_id, amount,
                                status, posted_journal_entry_id)
          VALUES (${fxA!.companyId}, 'customer_received', NULL, ${vendor!.id},
                  '2026-02-10', 'check', ${pFxA!.bankAccountId}, '1.0000',
                  'posted', ${pFxA!.invoiceJEId})
        `;
      }),
    ).rejects.toThrow(/counterparty_consistency/i);
  });

  it('positive_amount CHECK rejects zero payment amount', async () => {
    fxA ??= await createTestCompany('pay_a');
    pFxA ??= await seedReceivableFixture(fxA);

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`
          INSERT INTO payments (company_id, payment_type, customer_id, payment_date, payment_method,
                                bank_account_id, amount, status, posted_journal_entry_id)
          VALUES (${fxA!.companyId}, 'customer_received', ${pFxA!.customerId}, '2026-02-10', 'check',
                  ${pFxA!.bankAccountId}, '0', 'posted', ${pFxA!.invoiceJEId})
        `;
      }),
    ).rejects.toThrow(/positive_amount/i);
  });

  it('target_xor CHECK rejects an application with both invoiceId and billId', async () => {
    fxA ??= await createTestCompany('pay_a');
    pFxA ??= await seedReceivableFixture(fxA);

    const sql = getAdminSql();
    // Need a bill to attempt the cross-set application. Seed a tiny bill atomically.
    const billId = await sql.begin<string>(async (tx) => {
      const [vendor] = await tx<{ id: string }[]>`
        INSERT INTO vendors (company_id, display_name) VALUES (${fxA!.companyId}, 'V-XOR') RETURNING id
      `;
      const [ap] = await tx<{ id: string }[]>`
        INSERT INTO accounts (company_id, code, name, type, subtype)
        VALUES (${fxA!.companyId}, '2000', 'A/P', 'liability', 'accounts_payable') RETURNING id
      `;
      const [billEntry] = await tx<{ id: string }[]>`
        INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
        VALUES (${fxA!.companyId}, '2026-02-15', 'bill', ${fxA!.userId}) RETURNING id
      `;
      await tx`
        INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit, currency, fx_rate)
        VALUES
          (${billEntry!.id}, ${fxA!.companyId}, ${fxA!.expenseAccountId}, '5.0000', '0', 'USD', '1'),
          (${billEntry!.id}, ${fxA!.companyId}, ${ap!.id}, '0', '5.0000', 'USD', '1')
      `;
      const [b] = await tx<{ id: string }[]>`
        INSERT INTO bills (company_id, vendor_id, bill_number, bill_date, due_date,
                           status, subtotal, tax_amount, total, balance_due, posted_journal_entry_id)
        VALUES (${fxA!.companyId}, ${vendor!.id}, 'B-XOR', '2026-02-15', '2026-02-15',
                'open', '5.0000', '0.0000', '5.0000', '5.0000', ${billEntry!.id})
        RETURNING id
      `;
      return b!.id;
    });

    // Get an existing invoice id for the cross-set attempt.
    const [inv] = await withCompanyTx(fxA, 'owner', async (tx) =>
      tx<{ id: string }[]>`SELECT id FROM invoices WHERE invoice_number = 'INV-PAY-1'`,
    );
    const invoiceId = inv!.id;

    await expect(
      withCompanyTx(fxA, 'owner', async (tx) => {
        await tx`
          INSERT INTO payment_applications (payment_id, company_id, invoice_id, bill_id, amount)
          VALUES (${pFxA!.paymentId}, ${fxA!.companyId}, ${invoiceId}, ${billId}, '1.0000')
        `;
      }),
    ).rejects.toThrow(/target_xor/i);
  });
});
