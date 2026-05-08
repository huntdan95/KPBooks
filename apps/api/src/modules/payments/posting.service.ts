import {
  type Database,
  accounts,
  bills,
  invoices,
  paymentApplications,
  payments,
} from '@kpbooks/db';
import { Money } from '@kpbooks/money';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { PostingError, postEntry, reverseEntry } from '../ledger/posting.service.js';

/**
 * payments/posting.service -- creates and voids customer payments (received,
 * applied to invoices) and vendor / bill payments (sent, applied to bills).
 *
 * Posting rules:
 *   customer_received:
 *     DR  bank account                     (1 line, total amount)
 *     CR  A/R account                      (N lines, one per application)
 *     For each application: invoice.balance_due -= application.amount,
 *     status recomputed from new balance_due.
 *
 *   vendor_sent:
 *     DR  A/P account                      (N lines, one per application)
 *     CR  bank/credit-card account         (1 line, total amount)
 *     For each application: bill.balance_due -= application.amount,
 *     status recomputed from new balance_due.
 *
 * v1 invariants enforced:
 *   - sum(applications.amount) == payment.amount (no unapplied portion)
 *   - each application.amount > 0 and <= target.balance_due
 *   - each target is 'open' or 'partial' (not paid, not void)
 *   - currency is USD throughout
 */

const ApplicationInput = z
  .object({
    invoiceId: z.string().uuid().optional(),
    billId: z.string().uuid().optional(),
    amount: z.union([z.string(), z.number()]),
  })
  .strict()
  .refine((a) => Boolean(a.invoiceId) !== Boolean(a.billId), {
    message: 'application must reference exactly one of invoiceId or billId',
  });

export const CreatePaymentSchema = z
  .object({
    paymentType: z.enum(['customer_received', 'vendor_sent']),
    customerId: z.string().uuid().optional(),
    vendorId: z.string().uuid().optional(),
    paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    paymentMethod: z.enum(['check', 'cash', 'eft', 'credit_card', 'other']),
    reference: z.string().max(120).optional(),
    bankAccountId: z.string().uuid(),
    amount: z.union([z.string(), z.number()]),
    memo: z.string().max(500).optional(),
    applications: z.array(ApplicationInput).min(1, 'at least one application required'),
  })
  .strict()
  .refine(
    (p) =>
      (p.paymentType === 'customer_received' && p.customerId && !p.vendorId) ||
      (p.paymentType === 'vendor_sent' && p.vendorId && !p.customerId),
    { message: 'customer_received requires customerId; vendor_sent requires vendorId' },
  );

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;

export interface PaymentContext {
  companyId: string;
  userId: string;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'no_ar_account'
      | 'no_ap_account'
      | 'unknown_bank_account'
      | 'unknown_target'
      | 'wrong_target_for_type'
      | 'wrong_counterparty'
      | 'target_not_payable'
      | 'amount_mismatch'
      | 'over_application'
      | 'invalid_input'
      | 'already_voided'
      | 'not_found',
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

async function findOnlyAccountBySubtype(
  tx: Database,
  companyId: string,
  subtype: 'accounts_receivable' | 'accounts_payable',
): Promise<string> {
  const rows = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, companyId),
        eq(accounts.subtype, subtype),
        eq(accounts.isActive, true),
      ),
    )
    .orderBy(accounts.code);
  const first = rows[0];
  if (!first) {
    throw new PaymentError(
      `no active ${subtype} account on the chart of accounts`,
      subtype === 'accounts_receivable' ? 'no_ar_account' : 'no_ap_account',
    );
  }
  return first.id;
}

function statusFromBalance(balanceDue: Money, total: Money): 'open' | 'partial' | 'paid' {
  if (balanceDue.isZero()) return 'paid';
  if (balanceDue.eq(total)) return 'open';
  return 'partial';
}

export async function createPayment(
  tx: Database,
  ctx: PaymentContext,
  input: CreatePaymentInput,
): Promise<{ id: string; postedJournalEntryId: string; amount: string }> {
  const parsed = CreatePaymentSchema.safeParse(input);
  if (!parsed.success) {
    throw new PaymentError(
      parsed.error.issues.map((i) => i.message).join('; '),
      'invalid_input',
    );
  }
  const data = parsed.data;
  const isReceive = data.paymentType === 'customer_received';

  // Bank account must exist + be active.
  const [bankAccount] = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.id, data.bankAccountId));
  if (!bankAccount) {
    throw new PaymentError(`bank account ${data.bankAccountId} not found`, 'unknown_bank_account');
  }
  if (!bankAccount.isActive) {
    throw new PaymentError(`bank account ${data.bankAccountId} is inactive`, 'unknown_bank_account');
  }

  const arAccountId = isReceive ? await findOnlyAccountBySubtype(tx, ctx.companyId, 'accounts_receivable') : null;
  const apAccountId = isReceive ? null : await findOnlyAccountBySubtype(tx, ctx.companyId, 'accounts_payable');

  const totalAmount = Money.of(
    typeof data.amount === 'number' ? data.amount.toString() : data.amount,
    'USD',
  );
  if (!totalAmount.isPositive()) {
    throw new PaymentError('payment amount must be positive', 'invalid_input');
  }

  // Validate applications: each must reference a target on the right side.
  const computedApps = data.applications.map((a) => ({
    invoiceId: a.invoiceId ?? null,
    billId: a.billId ?? null,
    amount: Money.of(typeof a.amount === 'number' ? a.amount.toString() : a.amount, 'USD'),
  }));

  for (const app of computedApps) {
    if (isReceive && !app.invoiceId) {
      throw new PaymentError(
        'customer_received payments may only apply to invoices',
        'wrong_target_for_type',
      );
    }
    if (!isReceive && !app.billId) {
      throw new PaymentError(
        'vendor_sent payments may only apply to bills',
        'wrong_target_for_type',
      );
    }
    if (!app.amount.isPositive()) {
      throw new PaymentError('application amount must be positive', 'invalid_input');
    }
  }

  // Sum-of-applications must equal total.
  const sumApplied = computedApps.reduce(
    (acc, a) => acc.add(a.amount),
    Money.zero('USD'),
  );
  if (!sumApplied.eq(totalAmount)) {
    throw new PaymentError(
      `sum of applications (${sumApplied.toDecimalString()}) does not equal payment amount (${totalAmount.toDecimalString()})`,
      'amount_mismatch',
    );
  }

  // Load targets and validate ownership + state + sufficient balance.
  if (isReceive) {
    const ids = computedApps.map((a) => a.invoiceId!);
    const rows = await tx
      .select({
        id: invoices.id,
        customerId: invoices.customerId,
        status: invoices.status,
        total: invoices.total,
        balanceDue: invoices.balanceDue,
        invoiceNumber: invoices.invoiceNumber,
      })
      .from(invoices)
      .where(inArray(invoices.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const app of computedApps) {
      const inv = byId.get(app.invoiceId!);
      if (!inv) {
        throw new PaymentError(`invoice ${app.invoiceId} not found`, 'unknown_target');
      }
      if (inv.customerId !== data.customerId) {
        throw new PaymentError(
          `invoice ${inv.invoiceNumber} belongs to a different customer`,
          'wrong_counterparty',
        );
      }
      if (inv.status === 'void' || inv.status === 'paid') {
        throw new PaymentError(
          `invoice ${inv.invoiceNumber} is ${inv.status} and cannot accept payment`,
          'target_not_payable',
        );
      }
      const balanceDue = Money.of(inv.balanceDue, 'USD');
      if (app.amount.cmp(balanceDue) > 0) {
        throw new PaymentError(
          `application of ${app.amount.toDecimalString()} exceeds invoice ${inv.invoiceNumber} balance ${balanceDue.toDecimalString()}`,
          'over_application',
        );
      }
    }
  } else {
    const ids = computedApps.map((a) => a.billId!);
    const rows = await tx
      .select({
        id: bills.id,
        vendorId: bills.vendorId,
        status: bills.status,
        total: bills.total,
        balanceDue: bills.balanceDue,
        billNumber: bills.billNumber,
      })
      .from(bills)
      .where(inArray(bills.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const app of computedApps) {
      const b = byId.get(app.billId!);
      if (!b) {
        throw new PaymentError(`bill ${app.billId} not found`, 'unknown_target');
      }
      if (b.vendorId !== data.vendorId) {
        throw new PaymentError(
          `bill ${b.billNumber} belongs to a different vendor`,
          'wrong_counterparty',
        );
      }
      if (b.status === 'void' || b.status === 'paid') {
        throw new PaymentError(
          `bill ${b.billNumber} is ${b.status} and cannot accept payment`,
          'target_not_payable',
        );
      }
      const balanceDue = Money.of(b.balanceDue, 'USD');
      if (app.amount.cmp(balanceDue) > 0) {
        throw new PaymentError(
          `application of ${app.amount.toDecimalString()} exceeds bill ${b.billNumber} balance ${balanceDue.toDecimalString()}`,
          'over_application',
        );
      }
    }
  }

  // Pre-allocate the payment id for journal_entry source provenance.
  const paymentId = crypto.randomUUID();

  // Build journal lines.
  let entryId: string;
  try {
    const result = await postEntry(tx, ctx, {
      entryDate: data.paymentDate,
      sourceType: 'payment',
      sourceId: paymentId,
      memo: data.memo ?? (isReceive ? 'Customer payment received' : 'Vendor payment sent'),
      reference: data.reference,
      lines: isReceive
        ? [
            {
              accountId: data.bankAccountId,
              debit: totalAmount.toPgNumeric(),
              currency: 'USD' as const,
              fxRate: '1',
              memo: 'Payment received',
            },
            ...computedApps.map((a) => ({
              accountId: arAccountId!,
              credit: a.amount.toPgNumeric(),
              currency: 'USD' as const,
              fxRate: '1',
              memo: `Applied to invoice ${a.invoiceId}`,
            })),
          ]
        : [
            ...computedApps.map((a) => ({
              accountId: apAccountId!,
              debit: a.amount.toPgNumeric(),
              currency: 'USD' as const,
              fxRate: '1',
              memo: `Applied to bill ${a.billId}`,
            })),
            {
              accountId: data.bankAccountId,
              credit: totalAmount.toPgNumeric(),
              currency: 'USD' as const,
              fxRate: '1',
              memo: 'Payment sent',
            },
          ],
    });
    entryId = result.id;
  } catch (err) {
    if (err instanceof PostingError) {
      throw new PaymentError(`failed to post payment ledger entry: ${err.message}`, 'invalid_input');
    }
    throw err;
  }

  // Insert payment + applications.
  await tx.insert(payments).values({
    id: paymentId,
    companyId: ctx.companyId,
    paymentType: data.paymentType,
    customerId: data.customerId ?? null,
    vendorId: data.vendorId ?? null,
    paymentDate: data.paymentDate,
    paymentMethod: data.paymentMethod,
    reference: data.reference ?? null,
    bankAccountId: data.bankAccountId,
    amount: totalAmount.toPgNumeric(),
    memo: data.memo ?? null,
    status: 'posted',
    postedJournalEntryId: entryId,
  });

  await tx.insert(paymentApplications).values(
    computedApps.map((a) => ({
      paymentId,
      companyId: ctx.companyId,
      invoiceId: a.invoiceId,
      billId: a.billId,
      amount: a.amount.toPgNumeric(),
    })),
  );

  // Update each target's balance_due + status.
  for (const app of computedApps) {
    if (isReceive) {
      const [inv] = await tx
        .select({ total: invoices.total, balanceDue: invoices.balanceDue })
        .from(invoices)
        .where(eq(invoices.id, app.invoiceId!));
      const newBalance = Money.of(inv!.balanceDue, 'USD').sub(app.amount);
      const total = Money.of(inv!.total, 'USD');
      const newStatus = statusFromBalance(newBalance, total);
      await tx
        .update(invoices)
        .set({ balanceDue: newBalance.toPgNumeric(), status: newStatus })
        .where(eq(invoices.id, app.invoiceId!));
    } else {
      const [b] = await tx
        .select({ total: bills.total, balanceDue: bills.balanceDue })
        .from(bills)
        .where(eq(bills.id, app.billId!));
      const newBalance = Money.of(b!.balanceDue, 'USD').sub(app.amount);
      const total = Money.of(b!.total, 'USD');
      const newStatus = statusFromBalance(newBalance, total);
      await tx
        .update(bills)
        .set({ balanceDue: newBalance.toPgNumeric(), status: newStatus })
        .where(eq(bills.id, app.billId!));
    }
  }

  return { id: paymentId, postedJournalEntryId: entryId, amount: totalAmount.toPgNumeric() };
}

export async function voidPayment(
  tx: Database,
  ctx: PaymentContext,
  paymentId: string,
  opts: { voidDate: string; memo?: string | undefined },
): Promise<{ id: string; voidedJournalEntryId: string }> {
  const [pay] = await tx.select().from(payments).where(eq(payments.id, paymentId));
  if (!pay) {
    throw new PaymentError(`payment ${paymentId} not found`, 'not_found');
  }
  if (pay.status === 'void') {
    throw new PaymentError(`payment ${paymentId} is already voided`, 'already_voided');
  }

  // Reverse the journal entry. The original is locked in the same call.
  const reversal = await reverseEntry(tx, ctx, pay.postedJournalEntryId, {
    entryDate: opts.voidDate,
    memo: opts.memo ?? `Void payment ${paymentId.slice(0, 8)}`,
  });

  // Restore balance_due on each application's target. Use only non-voided
  // applications for this payment (all of them, since payment_applications
  // can't be soft-deleted).
  const apps = await tx
    .select()
    .from(paymentApplications)
    .where(eq(paymentApplications.paymentId, paymentId));

  for (const app of apps) {
    const appAmount = Money.of(app.amount, 'USD');
    if (app.invoiceId) {
      const [inv] = await tx
        .select({ total: invoices.total, balanceDue: invoices.balanceDue, status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, app.invoiceId));
      if (inv && inv.status !== 'void') {
        const newBalance = Money.of(inv.balanceDue, 'USD').add(appAmount);
        const total = Money.of(inv.total, 'USD');
        const newStatus = statusFromBalance(newBalance, total);
        await tx
          .update(invoices)
          .set({ balanceDue: newBalance.toPgNumeric(), status: newStatus })
          .where(eq(invoices.id, app.invoiceId));
      }
    } else if (app.billId) {
      const [b] = await tx
        .select({ total: bills.total, balanceDue: bills.balanceDue, status: bills.status })
        .from(bills)
        .where(eq(bills.id, app.billId));
      if (b && b.status !== 'void') {
        const newBalance = Money.of(b.balanceDue, 'USD').add(appAmount);
        const total = Money.of(b.total, 'USD');
        const newStatus = statusFromBalance(newBalance, total);
        await tx
          .update(bills)
          .set({ balanceDue: newBalance.toPgNumeric(), status: newStatus })
          .where(eq(bills.id, app.billId));
      }
    }
  }

  await tx
    .update(payments)
    .set({ status: 'void', voidedAt: new Date(), voidedJournalEntryId: reversal.id })
    .where(eq(payments.id, paymentId));

  return { id: paymentId, voidedJournalEntryId: reversal.id };
}

/**
 * hasActiveApplications -- helper for invoice/bill void to enforce
 * "must void payments first." Returns true if there's at least one
 * non-voided payment_application referencing the target.
 */
export async function hasActiveApplications(
  tx: Database,
  target: { kind: 'invoice'; id: string } | { kind: 'bill'; id: string },
): Promise<boolean> {
  const targetCol = target.kind === 'invoice' ? paymentApplications.invoiceId : paymentApplications.billId;
  const otherCol = target.kind === 'invoice' ? paymentApplications.billId : paymentApplications.invoiceId;
  const rows = await tx
    .select({ paymentId: paymentApplications.paymentId })
    .from(paymentApplications)
    .innerJoin(payments, eq(payments.id, paymentApplications.paymentId))
    .where(and(eq(targetCol, target.id), isNull(otherCol), ne(payments.status, 'void')))
    .limit(1);
  return rows.length > 0;
}
