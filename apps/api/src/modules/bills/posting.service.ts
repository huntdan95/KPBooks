import {
  type Database,
  accounts,
  billLines,
  bills,
  vendors,
} from '@kpbooks/db';
import { Money } from '@kpbooks/money';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { PostingError, postEntry, reverseEntry } from '../ledger/posting.service.js';

/**
 * bills/posting.service -- A/P mirror of invoices/posting.service. Posts a
 * bill and its journal_entry (DR expense per line, CR A/P) in one
 * transaction.
 *
 * Posting rules:
 *   - DR: one line per bill line, posted to that line's chosen expense
 *     (or fixed-asset / prepaid / COGS) account.
 *   - CR: company's first active account with subtype='accounts_payable'
 *     (typically "2000 Accounts Payable" from the seeded COA).
 *   - Currency: USD only at v1.
 *   - Tax not yet supported -- taxAmount must be 0.
 */

const LineInput = z.object({
  accountId: z.string().uuid(),
  description: z.string().min(1).max(500),
  quantity: z.union([z.string(), z.number()]).default('1'),
  unitPrice: z.union([z.string(), z.number()]).default('0'),
});

export const CreateBillSchema = z
  .object({
    vendorId: z.string().uuid(),
    billNumber: z.string().min(1).max(40),
    billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
      .optional(),
    memo: z.string().max(500).optional(),
    lines: z.array(LineInput).min(1, 'bill needs at least one line'),
  })
  .strict();

export type CreateBillInput = z.infer<typeof CreateBillSchema>;

export interface BillContext {
  companyId: string;
  userId: string;
}

export class BillError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'no_ap_account'
      | 'unknown_vendor'
      | 'unknown_expense_account'
      | 'inactive_account'
      | 'duplicate_number'
      | 'invalid_input'
      | 'already_voided'
      | 'not_found',
  ) {
    super(message);
    this.name = 'BillError';
  }
}

async function findApAccount(tx: Database, companyId: string): Promise<string> {
  const rows = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, companyId),
        eq(accounts.subtype, 'accounts_payable'),
        eq(accounts.isActive, true),
      ),
    )
    .orderBy(accounts.code);
  const first = rows[0];
  if (!first) {
    throw new BillError(
      'no active accounts_payable account on the chart of accounts',
      'no_ap_account',
    );
  }
  return first.id;
}

export async function createBill(
  tx: Database,
  ctx: BillContext,
  input: CreateBillInput,
): Promise<{ id: string; postedJournalEntryId: string; total: string }> {
  const parsed = CreateBillSchema.safeParse(input);
  if (!parsed.success) {
    throw new BillError(
      parsed.error.issues.map((i) => i.message).join('; '),
      'invalid_input',
    );
  }
  const data = parsed.data;

  const [vendor] = await tx
    .select({ id: vendors.id, defaultTermsDays: vendors.defaultTermsDays })
    .from(vendors)
    .where(eq(vendors.id, data.vendorId));
  if (!vendor) {
    throw new BillError(`vendor ${data.vendorId} not found`, 'unknown_vendor');
  }

  const distinctAccountIds = Array.from(new Set(data.lines.map((l) => l.accountId)));
  const accountRows = await tx
    .select({
      id: accounts.id,
      type: accounts.type,
      isActive: accounts.isActive,
      companyId: accounts.companyId,
    })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const accountById = new Map(accountRows.map((r) => [r.id, r]));
  for (const id of distinctAccountIds) {
    const a = accountById.get(id);
    if (!a) {
      throw new BillError(`account ${id} not found in company`, 'unknown_expense_account');
    }
    if (!a.isActive) {
      throw new BillError(`account ${id} is inactive`, 'inactive_account');
    }
  }

  const apAccountId = await findApAccount(tx, ctx.companyId);

  const computedLines = data.lines.map((l, idx) => {
    const qty = Money.of(typeof l.quantity === 'number' ? l.quantity.toString() : l.quantity, 'USD');
    const price = Money.of(
      typeof l.unitPrice === 'number' ? l.unitPrice.toString() : l.unitPrice,
      'USD',
    );
    const amount = price.mul(qty.toDecimalString());
    return {
      lineNumber: idx + 1,
      accountId: l.accountId,
      description: l.description,
      quantity: qty.toPgNumeric(),
      unitPrice: price.toPgNumeric(),
      amount,
    };
  });

  const subtotal = computedLines.reduce(
    (acc, l) => acc.add(l.amount),
    Money.zero('USD'),
  );
  const total = subtotal;

  if (total.isZero()) {
    throw new BillError('bill total cannot be zero', 'invalid_input');
  }

  const billId = crypto.randomUUID();
  const dueDate = data.dueDate ?? deriveDueDate(data.billDate, vendor.defaultTermsDays);

  let entryId: string;
  try {
    const result = await postEntry(tx, ctx, {
      entryDate: data.billDate,
      sourceType: 'bill',
      sourceId: billId,
      memo: data.memo ?? `Bill ${data.billNumber}`,
      reference: data.billNumber,
      lines: [
        ...computedLines.map((l) => ({
          accountId: l.accountId,
          debit: l.amount.toPgNumeric(),
          currency: 'USD' as const,
          fxRate: '1',
          memo: l.description,
        })),
        {
          accountId: apAccountId,
          credit: total.toPgNumeric(),
          currency: 'USD',
          fxRate: '1',
          memo: `Bill ${data.billNumber}`,
        },
      ],
    });
    entryId = result.id;
  } catch (err) {
    if (err instanceof PostingError) {
      throw new BillError(`failed to post bill ledger entry: ${err.message}`, 'invalid_input');
    }
    throw err;
  }

  try {
    await tx.insert(bills).values({
      id: billId,
      companyId: ctx.companyId,
      vendorId: data.vendorId,
      billNumber: data.billNumber,
      billDate: data.billDate,
      dueDate,
      termsDays: vendor.defaultTermsDays ?? null,
      status: 'open',
      memo: data.memo ?? null,
      subtotal: subtotal.toPgNumeric(),
      taxAmount: '0.0000',
      total: total.toPgNumeric(),
      balanceDue: total.toPgNumeric(),
      postedJournalEntryId: entryId,
    });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new BillError(
        `bill number ${data.billNumber} already exists`,
        'duplicate_number',
      );
    }
    throw err;
  }

  await tx.insert(billLines).values(
    computedLines.map((l) => ({
      billId,
      companyId: ctx.companyId,
      lineNumber: l.lineNumber,
      accountId: l.accountId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      amount: l.amount.toPgNumeric(),
    })),
  );

  return { id: billId, postedJournalEntryId: entryId, total: total.toPgNumeric() };
}

export async function voidBill(
  tx: Database,
  ctx: BillContext,
  billId: string,
  opts: { voidDate: string; memo?: string | undefined },
): Promise<{ id: string; voidedJournalEntryId: string }> {
  const [b] = await tx.select().from(bills).where(eq(bills.id, billId));
  if (!b) {
    throw new BillError(`bill ${billId} not found`, 'not_found');
  }
  if (b.status === 'void') {
    throw new BillError(`bill ${billId} is already voided`, 'already_voided');
  }

  const reversal = await reverseEntry(tx, ctx, b.postedJournalEntryId, {
    entryDate: opts.voidDate,
    memo: opts.memo ?? `Void bill ${b.billNumber}`,
  });

  await tx
    .update(bills)
    .set({
      status: 'void',
      voidedAt: new Date(),
      voidedJournalEntryId: reversal.id,
      balanceDue: '0.0000',
    })
    .where(eq(bills.id, billId));

  return { id: billId, voidedJournalEntryId: reversal.id };
}

function deriveDueDate(billDate: string, termsDays: number | null): string {
  if (!termsDays || termsDays <= 0) return billDate;
  const d = new Date(billDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + termsDays);
  return d.toISOString().slice(0, 10);
}
