import {
  type Database,
  accounts,
  customers,
  estimateLines,
  estimates,
  taxRates,
} from '@kpbooks/db';
import { Money } from '@kpbooks/money';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  CreateInvoiceSchema,
  InvoiceError,
  createInvoice,
  type InvoiceContext,
} from '../invoices/posting.service.js';

/**
 * estimates.service — quote / proposal CRUD plus convert-to-invoice. Estimates
 * never touch the ledger directly; only the conversion path does, and it does
 * so by delegating to the existing invoice posting service so all A/R goes
 * through one writer.
 */

const LineInput = z.object({
  accountId: z.string().uuid(),
  description: z.string().min(1).max(500),
  quantity: z.union([z.string(), z.number()]).default('1'),
  unitPrice: z.union([z.string(), z.number()]).default('0'),
  taxable: z.boolean().default(false),
});

export const CreateEstimateSchema = z
  .object({
    customerId: z.string().uuid(),
    estimateNumber: z.string().min(1).max(40),
    estimateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    expirationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    memo: z.string().max(500).optional(),
    taxRateId: z.string().uuid().optional(),
    lines: z.array(LineInput).min(1, 'estimate needs at least one line'),
  })
  .strict();

export type CreateEstimateInput = z.infer<typeof CreateEstimateSchema>;

export const UpdateEstimateSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    estimateNumber: z.string().min(1).max(40).optional(),
    estimateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    expirationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    memo: z.string().max(500).nullable().optional(),
    taxRateId: z.string().uuid().nullable().optional(),
    lines: z.array(LineInput).min(1).optional(),
  })
  .strict();

export type UpdateEstimateInput = z.infer<typeof UpdateEstimateSchema>;

export interface EstimateContext {
  companyId: string;
  userId: string;
}

export class EstimateError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'unknown_customer'
      | 'unknown_account'
      | 'inactive_account'
      | 'unknown_tax_rate'
      | 'inactive_tax_rate'
      | 'duplicate_number'
      | 'invalid_input'
      | 'wrong_status'
      | 'not_found',
  ) {
    super(message);
    this.name = 'EstimateError';
  }
}

interface ComputedTotals {
  computedLines: Array<{
    lineNumber: number;
    accountId: string;
    description: string;
    quantity: string;
    unitPrice: string;
    amount: Money;
    taxable: boolean;
  }>;
  subtotal: Money;
  taxAmount: Money;
  total: Money;
}

async function computeTotals(
  tx: Database,
  companyId: string,
  lines: Array<z.infer<typeof LineInput>>,
  taxRateId: string | undefined | null,
): Promise<ComputedTotals> {
  // Validate accounts exist + active.
  const distinctAccountIds = Array.from(new Set(lines.map((l) => l.accountId)));
  const accountRows = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.companyId, companyId));
  const accountById = new Map(accountRows.map((r) => [r.id, r]));
  for (const id of distinctAccountIds) {
    const a = accountById.get(id);
    if (!a) throw new EstimateError(`account ${id} not found in company`, 'unknown_account');
    if (!a.isActive) throw new EstimateError(`account ${id} is inactive`, 'inactive_account');
  }

  // Validate tax rate.
  let ratePercent = 0;
  if (taxRateId) {
    const [row] = await tx
      .select({ id: taxRates.id, ratePercent: taxRates.ratePercent, isActive: taxRates.isActive })
      .from(taxRates)
      .where(eq(taxRates.id, taxRateId));
    if (!row) throw new EstimateError(`tax rate ${taxRateId} not found`, 'unknown_tax_rate');
    if (!row.isActive)
      throw new EstimateError(`tax rate ${taxRateId} is inactive`, 'inactive_tax_rate');
    ratePercent = Number(row.ratePercent);
  }

  const computedLines = lines.map((l, idx) => {
    const qty = Money.of(
      typeof l.quantity === 'number' ? l.quantity.toString() : l.quantity,
      'USD',
    );
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

  const subtotal = computedLines.reduce((acc, l) => acc.add(l.amount), Money.zero('USD'));
  const taxableSubtotal = computedLines.reduce(
    (acc, l) => (l.taxable ? acc.add(l.amount) : acc),
    Money.zero('USD'),
  );
  let taxAmount = Money.zero('USD');
  if (Number.isFinite(ratePercent) && ratePercent > 0) {
    taxAmount = taxableSubtotal.mul((ratePercent / 100).toString());
  }
  const total = subtotal.add(taxAmount);
  return { computedLines, subtotal, taxAmount, total };
}

export async function createEstimate(
  tx: Database,
  ctx: EstimateContext,
  input: CreateEstimateInput,
): Promise<{ id: string; total: string }> {
  const parsed = CreateEstimateSchema.safeParse(input);
  if (!parsed.success) {
    throw new EstimateError(
      parsed.error.issues.map((i) => i.message).join('; '),
      'invalid_input',
    );
  }
  const data = parsed.data;

  const [customer] = await tx
    .select({ id: customers.id, defaultTermsDays: customers.defaultTermsDays })
    .from(customers)
    .where(eq(customers.id, data.customerId));
  if (!customer) {
    throw new EstimateError(`customer ${data.customerId} not found`, 'unknown_customer');
  }

  // Duplicate-number check (RLS scopes to company).
  const existing = await tx
    .select({ id: estimates.id })
    .from(estimates)
    .where(eq(estimates.estimateNumber, data.estimateNumber))
    .limit(1);
  if (existing.length > 0) {
    throw new EstimateError(
      `estimate number "${data.estimateNumber}" is already used`,
      'duplicate_number',
    );
  }

  const totals = await computeTotals(tx, ctx.companyId, data.lines, data.taxRateId);

  const [estimate] = await tx
    .insert(estimates)
    .values({
      companyId: ctx.companyId,
      customerId: data.customerId,
      estimateNumber: data.estimateNumber,
      estimateDate: data.estimateDate,
      ...(data.expirationDate ? { expirationDate: data.expirationDate } : {}),
      ...(customer.defaultTermsDays !== null && customer.defaultTermsDays !== undefined
        ? { termsDays: customer.defaultTermsDays }
        : {}),
      status: 'draft' as const,
      ...(data.memo ? { memo: data.memo } : {}),
      subtotal: totals.subtotal.toPgNumeric(),
      ...(data.taxRateId ? { taxRateId: data.taxRateId } : {}),
      taxAmount: totals.taxAmount.toPgNumeric(),
      total: totals.total.toPgNumeric(),
    })
    .returning();
  if (!estimate) throw new EstimateError('failed to create estimate', 'invalid_input');

  await tx.insert(estimateLines).values(
    totals.computedLines.map((l) => ({
      estimateId: estimate.id,
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

  return { id: estimate.id, total: totals.total.toPgNumeric() };
}

export async function updateEstimate(
  tx: Database,
  ctx: EstimateContext,
  estimateId: string,
  input: UpdateEstimateInput,
): Promise<{ id: string; total: string }> {
  const parsed = UpdateEstimateSchema.safeParse(input);
  if (!parsed.success) {
    throw new EstimateError(
      parsed.error.issues.map((i) => i.message).join('; '),
      'invalid_input',
    );
  }
  const data = parsed.data;

  const [current] = await tx.select().from(estimates).where(eq(estimates.id, estimateId));
  if (!current) throw new EstimateError(`estimate ${estimateId} not found`, 'not_found');
  if (current.status === 'converted') {
    throw new EstimateError(
      'estimate is converted; further edits are blocked',
      'wrong_status',
    );
  }

  // If lines or taxRate changed, recompute totals; otherwise keep existing.
  let totals: ComputedTotals | null = null;
  const taxRateForCompute =
    data.taxRateId === undefined ? current.taxRateId : data.taxRateId;
  if (data.lines || data.taxRateId !== undefined) {
    let lines: Array<z.infer<typeof LineInput>>;
    if (data.lines) {
      lines = data.lines;
    } else {
      const rows = await tx
        .select({
          accountId: estimateLines.accountId,
          description: estimateLines.description,
          quantity: estimateLines.quantity,
          unitPrice: estimateLines.unitPrice,
          taxable: estimateLines.taxable,
        })
        .from(estimateLines)
        .where(eq(estimateLines.estimateId, estimateId))
        .orderBy(asc(estimateLines.lineNumber));
      lines = rows.map((r) => ({
        accountId: r.accountId,
        description: r.description,
        quantity: r.quantity,
        unitPrice: r.unitPrice,
        taxable: r.taxable,
      }));
    }
    totals = await computeTotals(tx, ctx.companyId, lines, taxRateForCompute);
  }

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (data.customerId !== undefined) update.customerId = data.customerId;
  if (data.estimateNumber !== undefined) update.estimateNumber = data.estimateNumber;
  if (data.estimateDate !== undefined) update.estimateDate = data.estimateDate;
  if (data.expirationDate !== undefined) update.expirationDate = data.expirationDate;
  if (data.memo !== undefined) update.memo = data.memo;
  if (data.taxRateId !== undefined) update.taxRateId = data.taxRateId;
  if (totals) {
    update.subtotal = totals.subtotal.toPgNumeric();
    update.taxAmount = totals.taxAmount.toPgNumeric();
    update.total = totals.total.toPgNumeric();
  }

  await tx.update(estimates).set(update).where(eq(estimates.id, estimateId));

  if (data.lines && totals) {
    await tx.delete(estimateLines).where(eq(estimateLines.estimateId, estimateId));
    await tx.insert(estimateLines).values(
      totals.computedLines.map((l) => ({
        estimateId,
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
  }

  return {
    id: estimateId,
    total: totals ? totals.total.toPgNumeric() : current.total,
  };
}

export async function deleteEstimate(
  tx: Database,
  estimateId: string,
): Promise<void> {
  const [current] = await tx
    .select({ status: estimates.status })
    .from(estimates)
    .where(eq(estimates.id, estimateId));
  if (!current) throw new EstimateError(`estimate ${estimateId} not found`, 'not_found');
  if (current.status === 'converted') {
    throw new EstimateError('cannot delete a converted estimate', 'wrong_status');
  }
  // Lines cascade.
  await tx.delete(estimates).where(eq(estimates.id, estimateId));
}

export async function setEstimateStatus(
  tx: Database,
  estimateId: string,
  next: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired',
): Promise<void> {
  const [current] = await tx
    .select({ status: estimates.status })
    .from(estimates)
    .where(eq(estimates.id, estimateId));
  if (!current) throw new EstimateError(`estimate ${estimateId} not found`, 'not_found');
  if (current.status === 'converted') {
    throw new EstimateError(
      'estimate is converted; status cannot be changed',
      'wrong_status',
    );
  }
  await tx.update(estimates).set({ status: next }).where(eq(estimates.id, estimateId));
}

/**
 * Convert an estimate into a posted invoice. Snapshots all lines + tax onto
 * a new invoice (which posts via the standard A/R writer), then flips the
 * estimate to status='converted' with convertedInvoiceId set.
 *
 * Idempotency: if the estimate is already converted, returns the existing
 * convertedInvoiceId without doing anything.
 */
export async function convertEstimateToInvoice(
  tx: Database,
  ctx: EstimateContext,
  estimateId: string,
  opts: { invoiceNumber: string; invoiceDate?: string | undefined; dueDate?: string | undefined },
): Promise<{ estimateId: string; invoiceId: string }> {
  const [current] = await tx.select().from(estimates).where(eq(estimates.id, estimateId));
  if (!current) throw new EstimateError(`estimate ${estimateId} not found`, 'not_found');
  if (current.status === 'converted') {
    if (!current.convertedInvoiceId) {
      throw new EstimateError(
        'estimate marked converted but no invoice is linked',
        'wrong_status',
      );
    }
    return { estimateId, invoiceId: current.convertedInvoiceId };
  }
  if (current.status === 'declined') {
    throw new EstimateError('cannot convert a declined estimate', 'wrong_status');
  }

  const lineRows = await tx
    .select({
      accountId: estimateLines.accountId,
      description: estimateLines.description,
      quantity: estimateLines.quantity,
      unitPrice: estimateLines.unitPrice,
      taxable: estimateLines.taxable,
    })
    .from(estimateLines)
    .where(eq(estimateLines.estimateId, estimateId))
    .orderBy(asc(estimateLines.lineNumber));
  if (lineRows.length === 0) {
    throw new EstimateError('estimate has no lines', 'invalid_input');
  }

  const invoiceContext: InvoiceContext = ctx;
  const invoiceInput: z.infer<typeof CreateInvoiceSchema> = {
    customerId: current.customerId,
    invoiceNumber: opts.invoiceNumber,
    invoiceDate: opts.invoiceDate ?? new Date().toISOString().slice(0, 10),
    ...(opts.dueDate ? { dueDate: opts.dueDate } : {}),
    ...(current.memo ? { memo: current.memo } : {}),
    ...(current.taxRateId ? { taxRateId: current.taxRateId } : {}),
    lines: lineRows.map((l) => ({
      accountId: l.accountId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxable: l.taxable,
    })),
  };

  let invoiceId: string;
  try {
    const result = await createInvoice(tx, invoiceContext, invoiceInput);
    invoiceId = result.id;
  } catch (err) {
    if (err instanceof InvoiceError) {
      // Surface the invoice error code through the estimate error namespace.
      throw new EstimateError(`invoice creation failed: ${err.message}`, 'invalid_input');
    }
    throw err;
  }

  await tx
    .update(estimates)
    .set({
      status: 'converted',
      convertedInvoiceId: invoiceId,
      convertedAt: new Date(),
    })
    .where(eq(estimates.id, estimateId));

  return { estimateId, invoiceId };
}

export async function listEstimates(tx: Database, filter: { status?: string | undefined }) {
  const rows = await tx
    .select({
      id: estimates.id,
      estimateNumber: estimates.estimateNumber,
      estimateDate: estimates.estimateDate,
      expirationDate: estimates.expirationDate,
      status: estimates.status,
      customerId: estimates.customerId,
      customerName: customers.displayName,
      memo: estimates.memo,
      subtotal: estimates.subtotal,
      taxAmount: estimates.taxAmount,
      total: estimates.total,
      convertedInvoiceId: estimates.convertedInvoiceId,
      convertedAt: estimates.convertedAt,
      createdAt: estimates.createdAt,
    })
    .from(estimates)
    .leftJoin(customers, eq(customers.id, estimates.customerId))
    .where(filter.status ? eq(estimates.status, filter.status as never) : undefined)
    .orderBy(desc(estimates.estimateDate), desc(estimates.createdAt));
  return rows;
}

export async function getEstimate(tx: Database, estimateId: string) {
  const [head] = await tx
    .select({
      id: estimates.id,
      estimateNumber: estimates.estimateNumber,
      estimateDate: estimates.estimateDate,
      expirationDate: estimates.expirationDate,
      termsDays: estimates.termsDays,
      status: estimates.status,
      customerId: estimates.customerId,
      customerName: customers.displayName,
      memo: estimates.memo,
      subtotal: estimates.subtotal,
      taxRateId: estimates.taxRateId,
      taxAmount: estimates.taxAmount,
      total: estimates.total,
      convertedInvoiceId: estimates.convertedInvoiceId,
      convertedAt: estimates.convertedAt,
      createdAt: estimates.createdAt,
    })
    .from(estimates)
    .leftJoin(customers, eq(customers.id, estimates.customerId))
    .where(eq(estimates.id, estimateId));
  if (!head) return null;
  const lines = await tx
    .select({
      id: estimateLines.id,
      lineNumber: estimateLines.lineNumber,
      accountId: estimateLines.accountId,
      description: estimateLines.description,
      quantity: estimateLines.quantity,
      unitPrice: estimateLines.unitPrice,
      amount: estimateLines.amount,
      taxable: estimateLines.taxable,
    })
    .from(estimateLines)
    .where(and(eq(estimateLines.estimateId, estimateId)))
    .orderBy(asc(estimateLines.lineNumber));
  return { ...head, lines };
}
