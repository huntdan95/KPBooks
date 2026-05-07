/**
 * The deferred ledger balance trigger is the keystone of the whole system.
 * If it fires correctly, debits = credits is enforced at COMMIT regardless of
 * how many code paths reach `journal_lines`. If it doesn't, double-entry is
 * a polite suggestion. These tests are non-negotiable.
 */
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { Money } from '@kpbooks/money';
import { createTestCompany, dropTestCompany, withCompanyTx } from './setup';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('ledger balance trigger', () => {
  // Lazy fixture — created on first use, reused across the whole describe block.
  let fxPromise: ReturnType<typeof createTestCompany> | null = null;
  const getFx = () => (fxPromise ??= createTestCompany('balance'));

  afterAll(async () => {
    if (fxPromise) {
      const fx = await fxPromise;
      await dropTestCompany(fx.companyId);
    }
  });

  it('accepts a balanced two-line entry', async () => {
    const fx = await getFx();
    await withCompanyTx(fx, 'owner', async (tx) => {
      const [entry] = await tx<{ id: string }[]>`
        INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
        VALUES (${fx.companyId}, '2026-01-15', 'manual', ${fx.userId}) RETURNING id
      `;
      await tx`
        INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
        VALUES
          (${entry!.id}, ${fx.companyId}, ${fx.cashAccountId}, '100.0000', '0'),
          (${entry!.id}, ${fx.companyId}, ${fx.revenueAccountId}, '0', '100.0000')
      `;
    });
  });

  it('rejects an unbalanced entry at COMMIT', async () => {
    const fx = await getFx();
    await expect(
      withCompanyTx(fx, 'owner', async (tx) => {
        const [entry] = await tx<{ id: string }[]>`
          INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
          VALUES (${fx.companyId}, '2026-01-15', 'manual', ${fx.userId}) RETURNING id
        `;
        await tx`
          INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
          VALUES
            (${entry!.id}, ${fx.companyId}, ${fx.cashAccountId}, '100.0000', '0'),
            (${entry!.id}, ${fx.companyId}, ${fx.revenueAccountId}, '0', '99.9999')
        `;
      }),
    ).rejects.toThrow(/unbalanced/i);
  });

  it('rejects a single-line entry at COMMIT (min two lines)', async () => {
    const fx = await getFx();
    await expect(
      withCompanyTx(fx, 'owner', async (tx) => {
        const [entry] = await tx<{ id: string }[]>`
          INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
          VALUES (${fx.companyId}, '2026-01-15', 'manual', ${fx.userId}) RETURNING id
        `;
        await tx`
          INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
          VALUES (${entry!.id}, ${fx.companyId}, ${fx.cashAccountId}, '100.0000', '0')
        `;
      }),
    ).rejects.toThrow(/must have/i);
  });

  it('rejects a line with both debit and credit > 0 (check constraint)', async () => {
    const fx = await getFx();
    await expect(
      withCompanyTx(fx, 'owner', async (tx) => {
        const [entry] = await tx<{ id: string }[]>`
          INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
          VALUES (${fx.companyId}, '2026-01-15', 'manual', ${fx.userId}) RETURNING id
        `;
        await tx`
          INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
          VALUES
            (${entry!.id}, ${fx.companyId}, ${fx.cashAccountId}, '50.0000', '50.0000'),
            (${entry!.id}, ${fx.companyId}, ${fx.revenueAccountId}, '0', '0')
        `;
      }),
    ).rejects.toThrow();
  });

  it('property: any balanced multi-line entry commits', async () => {
    const fx = await getFx();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 2, maxLength: 8 }),
        async (amountsCents) => {
          // Build N lines summing to S; split into debits totaling S and credits totaling S.
          // We do this by alternating sign: half become debits, half become credits, then top up.
          const total = amountsCents.reduce((a, b) => a + b, 0);
          const debits: number[] = [];
          const credits: number[] = [];
          let dSum = 0;
          let cSum = 0;
          for (let i = 0; i < amountsCents.length; i++) {
            if (i % 2 === 0) {
              debits.push(amountsCents[i]!);
              dSum += amountsCents[i]!;
            } else {
              credits.push(amountsCents[i]!);
              cSum += amountsCents[i]!;
            }
          }
          // Add a balancing line to whichever side is short.
          if (dSum < cSum) debits.push(cSum - dSum);
          else if (cSum < dSum) credits.push(dSum - cSum);
          else {
            // Already balanced — but we still need >= 1 of each.
            if (debits.length === 0) debits.push(1);
            if (credits.length === 0) credits.push(1);
            debits.push(1);
            credits.push(1);
          }

          await withCompanyTx(fx, 'owner', async (tx) => {
            const [entry] = await tx<{ id: string }[]>`
              INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
              VALUES (${fx.companyId}, '2026-01-15', 'manual', ${fx.userId}) RETURNING id
            `;
            for (const cents of debits) {
              const amt = Money.fromMinorUnits(cents, 'USD', 2).toPgNumeric();
              await tx`
                INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
                VALUES (${entry!.id}, ${fx.companyId}, ${fx.cashAccountId}, ${amt}, '0')
              `;
            }
            for (const cents of credits) {
              const amt = Money.fromMinorUnits(cents, 'USD', 2).toPgNumeric();
              await tx`
                INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
                VALUES (${entry!.id}, ${fx.companyId}, ${fx.revenueAccountId}, '0', ${amt})
              `;
            }
          });
          return true;
        },
      ),
      { numRuns: 25 },
    );
    expect(true).toBe(true);
  });

  it('property: any unbalanced entry is rejected', async () => {
    const fx = await getFx();
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        async (debitCents, creditCents) => {
          fc.pre(debitCents !== creditCents);

          const debit = Money.fromMinorUnits(debitCents, 'USD', 2).toPgNumeric();
          const credit = Money.fromMinorUnits(creditCents, 'USD', 2).toPgNumeric();

          let threw = false;
          try {
            await withCompanyTx(fx, 'owner', async (tx) => {
              const [entry] = await tx<{ id: string }[]>`
                INSERT INTO journal_entries (company_id, entry_date, source_type, created_by)
                VALUES (${fx.companyId}, '2026-01-15', 'manual', ${fx.userId}) RETURNING id
              `;
              await tx`
                INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit)
                VALUES
                  (${entry!.id}, ${fx.companyId}, ${fx.cashAccountId}, ${debit}, '0'),
                  (${entry!.id}, ${fx.companyId}, ${fx.revenueAccountId}, '0', ${credit})
              `;
            });
          } catch {
            threw = true;
          }
          return threw;
        },
      ),
      { numRuns: 25 },
    );
  });
});
