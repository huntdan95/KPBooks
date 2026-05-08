import {
  type Database,
  accounts,
  customers,
  invoiceLines,
  invoices,
} from '@kpbooks/db';
import { Money } from '@kpbooks/money';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { PostingError, postEntry, reverseEntry } from '../ledger/posting.service.js';
import { hasActiveApplications } from '../payments/posting.service.js';

/**
 * invoices/posting.service — the single entry point for creating and voiding A/R
 * invoices. Wraps the ledger postEntry so an invoice and its journal_entry are
 * always written in the same transaction; if either side fails, neither persists.
 *
 * Posting rules:
 *   • DR: company's first active account with subtype='accounts_receivable'
 *     (typically "1100 Accounts Receivable" from the seeded COA).
 *   • CR: one line per invoice line, posted to that line's chosen revenue/income
 *     account.
 *   • Currency is USD only at v1; multi-currency invoices come later.
 *   • Tax is not yet supported — taxAmount must be 0.
 */

const LineInput = z.object({
  accountId: z.string().uuid(),
  description: z.string().min(1).max(500),
  quantity: z.union([z.string(), z.number()]).default('1'),
  unitPrice: z.union([z.string(), z.number()]).default('0'),
});

export const CreateInvoiceSchema = z
  .object({
    customerId: z.string().uuid(),
    invoiceNumber: z.string().min(1).max(40),
    invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
      .optional(),
    memo: z.string().max(500).optional(),
    lines: z.array(LineInput).min(1, 'invoice needs at least one line'),
  })
  .strict();

export type CreateInvoiceInput = z.infer<typeof CreateInvoiceSchema>;

export interface InvoiceContext {
  companyId: string;
  userId: string;
}

export class InvoiceError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'no_ar_account'
      | 'unknown_customer'
      | 'unknown_revenue_account'
      | 'cross_company_account'
      | 'inactive_account'
      | 'duplicate_number'
      | 'invalid_input'
      | 'already_voided'
      | 'not_found',
  ) {
    super(message);
    this.name = 'InvoiceError';
  }
}

/**
 * Find the company's default A/R account: first active account whose subtype is
 * 'accounts_receivable', sorted by code. Most companies have exactly one (the
 * seeded "1100 Accounts Receivable").
 */
async function findArAccount(tx: Database, companyId: string): Promise<string> {
  const rows = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, companyId),
        eq(accounts.subtype, 'accounts_receivable'),
        eq(accounts.isActive, true),
      ),
    )
    .orderBy(accounts.code);
  const first = rows[0];
  if (!first) {
    throw new InvoiceError(
      'no active accounts_receivable account on the chart of accounts',
      'no_ar_account',
    );
  }
  return first.id;
}

export async function createInvoice(
  tx: Database,
  ctx: InvoiceContext,
  input: CreateInvoiceInput,
): Promise<{ id: string; postedJournalEntryId: string; total: string }> {
  const parsed = CreateInvoiceSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvoiceError(
      parsed.error.issues.map((i) => i.message).join('; '),
      'invalid_input',
    );
  }
  const data = parsed.data;

  // Resolve customer (RLS guarantees it belongs to ctx.companyId).
  const [customer] = await tx
    .select({ id: customers.id, defaultTermsDays: customers.defaultTermsDays })
    .from(customers)
    .where(eq(customers.id, data.customerId));
  if (!customer) {
    throw new InvoiceError(`customer ${data.customerId} not found`, 'unknown_customer');
  }

  // Resolve revenue accounts (RLS scopes to company; we still validate they
  // exist + active + cross-check companyId for clearer error messages).
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
      throw new InvoiceError(`account ${id} not found in company`, 'unknown_revenue_account');
    }
    if (!a.isActive) {
      throw new InvoiceError(`account ${id} is inactive`, 'inactive_account');
    }
  }

  const arAccountId = await findArAccount(tx, ctx.companyId);

  // Compute per-line amounts and totals using Money to avoid float drift.
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
  const total = subtotal; // tax is 0 in v1

  // Reject zero-total invoices — almost always an input bug, never legitimate.
  if (total.isZero()) {
    throw new InvoiceError('invoice total cannot be zero', 'invalid_input');
  }

  // Pre-allocate the invoice UUID so the journal_entry can carry it as
  // sourceId (provenance) before we insert the invoice row.
  const invoiceId = crypto.randomUUID();

  const dueDate = data.dueDate ?? deriveDueDate(data.invoiceDate, customer.defaultTermsDays);

  // Post the journal entry first. Closed-period guard, balance check, RLS all
  // fire at the ledger layer; we get an InvoiceError out if posting failed.
  let entryId: string;
  try {
    const result = await postEntry(tx, ctx, {
      entryDate: data.invoiceDate,
      sourceType: 'invoice',
      sourceId: invoiceId,
      memo: data.memo ?? `Invoice ${data.invoiceNumber}`,
      reference: data.invoiceNumber,
      lines: [
        {
          accountId: arAccountId,
          debit: total.toPgNumeric(),
          currency: 'USD',
          fxRate: '1',
          memo: `Invoice ${data.invoiceNumber}`,
        },
        ...computedLines.map((l) => ({
          accountId: l.accountId,
          credit: l.amount.toPgNumeric(),
          currency: 'USD' as const,
          fxRate: '1',
          memo: l.description,
        })),
      ],
    });
    entryId = result.id;
  } catch (err) {
    if (err instanceof PostingError) {
      throw new InvoiceError(`failed to post invoice ledger entry: ${err.message}`, 'invalid_input');
    }
    throw err;
  }

  // Insert the invoice row.
  try {
    await tx.insert(invoices).values({
      id: invoiceId,
      companyId: ctx.companyId,
      customerId: data.customerId,
      invoiceNumber: data.invoiceNumber,
      invoiceDate: data.invoiceDate,
      dueDate,
      termsDays: customer.defaultTermsDays ?? null,
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
      throw new InvoiceError(
        `invoice number ${data.invoiceNumber} already exists`,
        'duplicate_number',
      );
    }
    throw err;
  }

  // Insert lines.
  await tx.insert(invoiceLines).values(
    computedLines.map((l) => ({
      invoiceId,
      companyId: ctx.companyId,
      lineNumber: l.lineNumber,
      accountId: l.accountId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      amount: l.amount.toPgNumeric(),
    })),
  );

  return { id: invoiceId, postedJournalEntryId: entryId, total: total.toPgNumeric() };
}

export async function voidInvoice(
  tx: Database,
  ctx: InvoiceContext,
  invoiceId: string,
  opts: { voidDate: string; memo?: string | undefined },
): Promise<{ id: string; voidedJournalEntryId: string }> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) {
    throw new InvoiceError(`invoice ${invoiceId} not found`, 'not_found');
  }
  if (inv.status === 'void') {
    throw new InvoiceError(`invoice ${invoiceId} is already voided`, 'already_voided');
  }

  if (await hasActiveApplications(tx, { kind: 'invoice', id: invoiceId })) {
    throw new InvoiceError(
      `invoice ${invoiceId} has active payments applied; void those payments first`,
      'invalid_input',
    );
  }

  const reversal = await reverseEntry(tx, ctx, inv.postedJournalEntryId, {
    entryDate: opts.voidDate,
    memo: opts.memo ?? `Void invoice ${inv.invoiceNumber}`,
  });

  await tx
    .update(invoices)
    .set({
      status: 'void',
      voidedAt: new Date(),
      voidedJournalEntryId: reversal.id,
      balanceDue: '0.0000',
    })
    .where(eq(invoices.id, invoiceId));

  return { id: invoiceId, voidedJournalEntryId: reversal.id };
}

/**
 * dueDate = invoiceDate + termsDays; if no terms, equals invoiceDate
 * ("Due on receipt"). Pure date math — no time-of-day logic.
 */
function deriveDueDate(invoiceDate: string, termsDays: number | null): string {
  if (!termsDays || termsDays <= 0) return invoiceDate;
  const d = new Date(invoiceDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + termsDays);
  return d.toISOString().slice(0, 10);
}
