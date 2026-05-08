import {
  type Database,
  accounts,
  customers,
  invoiceLines,
  invoices,
  taxRates,
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
  taxable: z.boolean().default(false),
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
    /** Optional tax rate to apply to taxable lines; null = no tax. */
    taxRateId: z.string().uuid().optional(),
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
      | 'no_tax_payable_account'
      | 'unknown_customer'
      | 'unknown_revenue_account'
      | 'unknown_tax_rate'
      | 'inactive_tax_rate'
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

/**
 * Find the company's sales-tax payable account. v1 looks up by name
 * "Sales Tax Payable" (the seeded default). If multiple match, takes
 * the first by code. Throws when tax > 0 but no account exists.
 */
async function findSalesTaxPayableAccount(
  tx: Database,
  companyId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, companyId),
        eq(accounts.name, 'Sales Tax Payable'),
        eq(accounts.isActive, true),
      ),
    )
    .orderBy(accounts.code);
  return rows[0]?.id ?? null;
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

  // Resolve tax rate if provided.
  let taxRate: { id: string; ratePercent: string } | null = null;
  if (data.taxRateId) {
    const [row] = await tx
      .select({
        id: taxRates.id,
        ratePercent: taxRates.ratePercent,
        isActive: taxRates.isActive,
      })
      .from(taxRates)
      .where(eq(taxRates.id, data.taxRateId));
    if (!row) {
      throw new InvoiceError(`tax rate ${data.taxRateId} not found`, 'unknown_tax_rate');
    }
    if (!row.isActive) {
      throw new InvoiceError(`tax rate ${data.taxRateId} is inactive`, 'inactive_tax_rate');
    }
    taxRate = { id: row.id, ratePercent: row.ratePercent };
  }

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
      taxable: l.taxable,
    };
  });

  const subtotal = computedLines.reduce(
    (acc, l) => acc.add(l.amount),
    Money.zero('USD'),
  );

  // Tax = sum(taxable lines) * (rate / 100). Computed in Money so the
  // posted JE matches the stored taxAmount to the cent.
  let taxAmount = Money.zero('USD');
  let taxPayableAccountId: string | null = null;
  if (taxRate) {
    const taxableSubtotal = computedLines.reduce(
      (acc, l) => (l.taxable ? acc.add(l.amount) : acc),
      Money.zero('USD'),
    );
    // ratePercent is e.g. "8.7500"; divide by 100 for fraction.
    const ratePercent = Number(taxRate.ratePercent);
    if (Number.isFinite(ratePercent) && ratePercent > 0) {
      taxAmount = taxableSubtotal.mul((ratePercent / 100).toString());
    }
    if (!taxAmount.isZero()) {
      taxPayableAccountId = await findSalesTaxPayableAccount(tx, ctx.companyId);
      if (!taxPayableAccountId) {
        throw new InvoiceError(
          'tax > 0 but no active "Sales Tax Payable" account exists; create one in Chart of Accounts (liability / other_current_liability)',
          'no_tax_payable_account',
        );
      }
    }
  }

  const total = subtotal.add(taxAmount);

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
        ...(taxPayableAccountId && !taxAmount.isZero()
          ? [
              {
                accountId: taxPayableAccountId,
                credit: taxAmount.toPgNumeric(),
                currency: 'USD' as const,
                fxRate: '1',
                memo: `Sales tax (${taxRate!.ratePercent}%)`,
              },
            ]
          : []),
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
      taxRateId: taxRate?.id ?? null,
      taxAmount: taxAmount.toPgNumeric(),
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
      taxable: l.taxable,
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
