import {
  type Database,
  accounts,
  payrollRunLines,
  payrollRuns,
  vendors,
} from '@kpbooks/db';
import { Money } from '@kpbooks/money';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BillError, createBill, voidBill } from '../bills/posting.service.js';
import { PaymentError, createPayment, voidPayment } from '../payments/posting.service.js';

/**
 * payroll-runs.service -- batch entry of paychecks for one pay period.
 *
 * On POST, each draft line writes a real bill + a real payment via the
 * existing posting services (so all the same RLS / lock-after-post /
 * journal-entry plumbing fires that already protects ad-hoc bills and
 * payments). The line stamps posted_payment_id back on success, and
 * payroll_runs.status flips to 'posted' (DB lock-after-post trigger
 * locks the lines from there).
 *
 * On VOID, each line's payment + bill are voided (which writes reversing
 * journal entries via the existing void services), and the run flips to
 * 'voided'. The line history is preserved so the user can see what the
 * payroll batch was for audit purposes.
 *
 * KPBooks does NOT compute taxes. Gross / FIT / FICA / Medicare / state /
 * other are all entered manually per row -- the values get stamped on the
 * pay-stub PDF (slice #30) but the bill + payment are at NET so the
 * books reflect what the bank actually saw.
 */

const PAY_SCHEDULES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const;
const WORKER_TYPES_RUN = ['contractor', 'employee', 'subcontractor'] as const;

export class PayrollRunError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'wrong_status'
      | 'invalid_input'
      | 'no_bank_account'
      | 'no_lines'
      | 'unknown_vendor'
      | 'unknown_account'
      | 'inactive_account'
      | 'bill_failed'
      | 'payment_failed',
  ) {
    super(message);
    this.name = 'PayrollRunError';
  }
}

export interface PayrollRunContext {
  companyId: string;
  userId: string;
}

// -- Schemas ---------------------------------------------------------------

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const NumLike = z.union([z.string(), z.number()]);

export const CreatePayrollRunSchema = z
  .object({
    payDate: DateOnly,
    periodStart: DateOnly,
    periodEnd: DateOnly,
    paySchedule: z.enum(PAY_SCHEDULES).optional(),
    workerTypeFilter: z.enum(WORKER_TYPES_RUN).optional(),
    bankAccountId: z.string().uuid().optional(),
    memo: z.string().max(500).optional(),
  })
  .strict();
export type CreatePayrollRunInput = z.infer<typeof CreatePayrollRunSchema>;

export const UpdatePayrollRunSchema = z
  .object({
    payDate: DateOnly.optional(),
    periodStart: DateOnly.optional(),
    periodEnd: DateOnly.optional(),
    paySchedule: z.enum(PAY_SCHEDULES).nullable().optional(),
    workerTypeFilter: z.enum(WORKER_TYPES_RUN).nullable().optional(),
    bankAccountId: z.string().uuid().nullable().optional(),
    memo: z.string().max(500).nullable().optional(),
  })
  .strict();
export type UpdatePayrollRunInput = z.infer<typeof UpdatePayrollRunSchema>;

export const AddLineSchema = z
  .object({
    vendorId: z.string().uuid(),
    hours: NumLike.optional(),
    rate: NumLike.optional(),
    gross: NumLike,
    federalIncomeTax: NumLike.optional(),
    socialSecurity: NumLike.optional(),
    medicare: NumLike.optional(),
    stateIncomeTax: NumLike.optional(),
    otherDeductions: NumLike.optional(),
    /** If omitted, computed as gross - sum(deductions). */
    net: NumLike.optional(),
    memo: z.string().max(500).optional(),
  })
  .strict();
export type AddLineInput = z.infer<typeof AddLineSchema>;

export const UpdateLineSchema = z
  .object({
    hours: NumLike.nullable().optional(),
    rate: NumLike.nullable().optional(),
    gross: NumLike.optional(),
    federalIncomeTax: NumLike.optional(),
    socialSecurity: NumLike.optional(),
    medicare: NumLike.optional(),
    stateIncomeTax: NumLike.optional(),
    otherDeductions: NumLike.optional(),
    net: NumLike.optional(),
    memo: z.string().max(500).nullable().optional(),
  })
  .strict();
export type UpdateLineInput = z.infer<typeof UpdateLineSchema>;

// -- Helpers ---------------------------------------------------------------

function toDecimalString(v: string | number | undefined, fallback = '0'): string {
  if (v === undefined) return fallback;
  return typeof v === 'number' ? v.toString() : v;
}

function computeNet(input: {
  gross: string;
  fit?: string | undefined;
  ss?: string | undefined;
  med?: string | undefined;
  sit?: string | undefined;
  other?: string | undefined;
}): string {
  const sum = Money.of(input.fit ?? '0', 'USD')
    .add(Money.of(input.ss ?? '0', 'USD'))
    .add(Money.of(input.med ?? '0', 'USD'))
    .add(Money.of(input.sit ?? '0', 'USD'))
    .add(Money.of(input.other ?? '0', 'USD'));
  return Money.of(input.gross, 'USD').sub(sum).toPgNumeric();
}

async function recomputeRunTotals(tx: Database, runId: string): Promise<void> {
  const totals = await tx.execute(sql`
    SELECT
      COALESCE(SUM(gross), 0) AS total_gross,
      COALESCE(SUM(net), 0)   AS total_net
    FROM payroll_run_lines
    WHERE payroll_run_id = ${runId}
  `);
  const row = (totals as unknown as Array<{ total_gross: string; total_net: string }>)[0];
  if (!row) return;
  await tx
    .update(payrollRuns)
    .set({ totalGross: row.total_gross, totalNet: row.total_net, updatedAt: new Date() })
    .where(eq(payrollRuns.id, runId));
}

// -- CRUD ------------------------------------------------------------------

export async function createPayrollRun(
  tx: Database,
  ctx: PayrollRunContext,
  input: CreatePayrollRunInput,
): Promise<{ id: string }> {
  const data = CreatePayrollRunSchema.parse(input);
  if (data.periodEnd < data.periodStart) {
    throw new PayrollRunError('periodEnd must be on/after periodStart', 'invalid_input');
  }
  if (data.payDate < data.periodStart) {
    throw new PayrollRunError('payDate must be on/after periodStart', 'invalid_input');
  }
  const insert: typeof payrollRuns.$inferInsert = {
    companyId: ctx.companyId,
    payDate: data.payDate,
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
    status: 'draft',
    ...(data.paySchedule ? { paySchedule: data.paySchedule } : {}),
    ...(data.workerTypeFilter ? { workerTypeFilter: data.workerTypeFilter } : {}),
    ...(data.bankAccountId ? { bankAccountId: data.bankAccountId } : {}),
    ...(data.memo ? { memo: data.memo } : {}),
    ...(ctx.userId ? { createdByUserId: ctx.userId } : {}),
  };
  const [created] = await tx
    .insert(payrollRuns)
    .values(insert)
    .returning({ id: payrollRuns.id });
  if (!created) throw new PayrollRunError('failed to create run', 'invalid_input');
  return { id: created.id };
}

export async function updatePayrollRun(
  tx: Database,
  runId: string,
  input: UpdatePayrollRunInput,
): Promise<void> {
  const data = UpdatePayrollRunSchema.parse(input);
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
  if (!run) throw new PayrollRunError(`run ${runId} not found`, 'not_found');
  if (run.status !== 'draft') {
    throw new PayrollRunError(`run is ${run.status}; only drafts can be edited`, 'wrong_status');
  }
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (data.payDate !== undefined) update.payDate = data.payDate;
  if (data.periodStart !== undefined) update.periodStart = data.periodStart;
  if (data.periodEnd !== undefined) update.periodEnd = data.periodEnd;
  if (data.paySchedule !== undefined) update.paySchedule = data.paySchedule;
  if (data.workerTypeFilter !== undefined) update.workerTypeFilter = data.workerTypeFilter;
  if (data.bankAccountId !== undefined) update.bankAccountId = data.bankAccountId;
  if (data.memo !== undefined) update.memo = data.memo;
  await tx.update(payrollRuns).set(update).where(eq(payrollRuns.id, runId));
}

export async function deletePayrollRun(tx: Database, runId: string): Promise<void> {
  const [run] = await tx
    .select({ status: payrollRuns.status })
    .from(payrollRuns)
    .where(eq(payrollRuns.id, runId));
  if (!run) throw new PayrollRunError(`run ${runId} not found`, 'not_found');
  if (run.status !== 'draft') {
    throw new PayrollRunError(
      `run is ${run.status}; only drafts can be deleted (use void on posted runs)`,
      'wrong_status',
    );
  }
  // Lines cascade.
  await tx.delete(payrollRuns).where(eq(payrollRuns.id, runId));
}

// -- Lines -----------------------------------------------------------------

export async function addLine(
  tx: Database,
  ctx: PayrollRunContext,
  runId: string,
  input: AddLineInput,
): Promise<{ id: string }> {
  const data = AddLineSchema.parse(input);
  const [run] = await tx
    .select({ status: payrollRuns.status })
    .from(payrollRuns)
    .where(eq(payrollRuns.id, runId));
  if (!run) throw new PayrollRunError(`run ${runId} not found`, 'not_found');
  if (run.status !== 'draft') {
    throw new PayrollRunError(`run is ${run.status}; cannot add lines`, 'wrong_status');
  }

  const [vendor] = await tx
    .select({ id: vendors.id, workerType: vendors.workerType, isActive: vendors.isActive })
    .from(vendors)
    .where(eq(vendors.id, data.vendorId));
  if (!vendor) throw new PayrollRunError(`vendor ${data.vendorId} not found`, 'unknown_vendor');
  if (!vendor.isActive) {
    throw new PayrollRunError(`vendor ${data.vendorId} is inactive`, 'unknown_vendor');
  }

  const gross = toDecimalString(data.gross);
  const fit = toDecimalString(data.federalIncomeTax);
  const ss = toDecimalString(data.socialSecurity);
  const med = toDecimalString(data.medicare);
  const sit = toDecimalString(data.stateIncomeTax);
  const other = toDecimalString(data.otherDeductions);
  const net =
    data.net !== undefined
      ? toDecimalString(data.net)
      : computeNet({ gross, fit, ss, med, sit, other });
  if (Number(net) < 0) {
    throw new PayrollRunError('net is negative; gross must cover deductions', 'invalid_input');
  }

  const insert: typeof payrollRunLines.$inferInsert = {
    payrollRunId: runId,
    companyId: ctx.companyId,
    vendorId: data.vendorId,
    workerTypeAtCreation: vendor.workerType,
    gross,
    federalIncomeTax: fit,
    socialSecurity: ss,
    medicare: med,
    stateIncomeTax: sit,
    otherDeductions: other,
    net,
    ...(data.hours !== undefined ? { hours: toDecimalString(data.hours) } : {}),
    ...(data.rate !== undefined ? { rate: toDecimalString(data.rate) } : {}),
    ...(data.memo ? { memo: data.memo } : {}),
  };
  const [created] = await tx
    .insert(payrollRunLines)
    .values(insert)
    .returning({ id: payrollRunLines.id });
  if (!created) throw new PayrollRunError('failed to add line', 'invalid_input');
  await recomputeRunTotals(tx, runId);
  return { id: created.id };
}

export async function updateLine(
  tx: Database,
  runId: string,
  lineId: string,
  input: UpdateLineInput,
): Promise<void> {
  const data = UpdateLineSchema.parse(input);
  const [run] = await tx
    .select({ status: payrollRuns.status })
    .from(payrollRuns)
    .where(eq(payrollRuns.id, runId));
  if (!run) throw new PayrollRunError(`run ${runId} not found`, 'not_found');
  if (run.status !== 'draft') {
    throw new PayrollRunError(`run is ${run.status}; cannot edit lines`, 'wrong_status');
  }
  const [existing] = await tx
    .select()
    .from(payrollRunLines)
    .where(eq(payrollRunLines.id, lineId));
  if (!existing || existing.payrollRunId !== runId) {
    throw new PayrollRunError(`line ${lineId} not found on run ${runId}`, 'not_found');
  }

  const merged = {
    gross: data.gross !== undefined ? toDecimalString(data.gross) : existing.gross,
    fit:
      data.federalIncomeTax !== undefined
        ? toDecimalString(data.federalIncomeTax)
        : existing.federalIncomeTax,
    ss:
      data.socialSecurity !== undefined
        ? toDecimalString(data.socialSecurity)
        : existing.socialSecurity,
    med: data.medicare !== undefined ? toDecimalString(data.medicare) : existing.medicare,
    sit:
      data.stateIncomeTax !== undefined
        ? toDecimalString(data.stateIncomeTax)
        : existing.stateIncomeTax,
    other:
      data.otherDeductions !== undefined
        ? toDecimalString(data.otherDeductions)
        : existing.otherDeductions,
  };
  const net =
    data.net !== undefined ? toDecimalString(data.net) : computeNet(merged);
  if (Number(net) < 0) {
    throw new PayrollRunError('net is negative', 'invalid_input');
  }

  const update: Record<string, unknown> = {
    gross: merged.gross,
    federalIncomeTax: merged.fit,
    socialSecurity: merged.ss,
    medicare: merged.med,
    stateIncomeTax: merged.sit,
    otherDeductions: merged.other,
    net,
  };
  if (data.hours !== undefined) {
    update.hours = data.hours === null ? null : toDecimalString(data.hours);
  }
  if (data.rate !== undefined) {
    update.rate = data.rate === null ? null : toDecimalString(data.rate);
  }
  if (data.memo !== undefined) update.memo = data.memo;
  await tx.update(payrollRunLines).set(update).where(eq(payrollRunLines.id, lineId));
  await recomputeRunTotals(tx, runId);
}

export async function removeLine(tx: Database, runId: string, lineId: string): Promise<void> {
  const [run] = await tx
    .select({ status: payrollRuns.status })
    .from(payrollRuns)
    .where(eq(payrollRuns.id, runId));
  if (!run) throw new PayrollRunError(`run ${runId} not found`, 'not_found');
  if (run.status !== 'draft') {
    throw new PayrollRunError(`run is ${run.status}; cannot remove lines`, 'wrong_status');
  }
  await tx
    .delete(payrollRunLines)
    .where(and(eq(payrollRunLines.id, lineId), eq(payrollRunLines.payrollRunId, runId)));
  await recomputeRunTotals(tx, runId);
}

// -- Eligible workers (for the wizard) -------------------------------------

export interface EligibleWorker {
  vendorId: string;
  displayName: string;
  workerType: 'contractor' | 'employee' | 'subcontractor' | 'not_a_worker';
  payRate: string | null;
  payRateBasis: string | null;
  paySchedule: string | null;
  defaultExpenseAccountId: string | null;
}

export async function listEligibleWorkers(
  tx: Database,
  filter: {
    workerType?: 'contractor' | 'employee' | 'subcontractor' | undefined;
    paySchedule?: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | undefined;
  },
): Promise<EligibleWorker[]> {
  const rows = await tx
    .select({
      id: vendors.id,
      displayName: vendors.displayName,
      workerType: vendors.workerType,
      payRate: vendors.payRate,
      payRateBasis: vendors.payRateBasis,
      paySchedule: vendors.paySchedule,
      defaultExpenseAccountId: vendors.defaultExpenseAccountId,
    })
    .from(vendors)
    .where(
      and(
        eq(vendors.isActive, true),
        filter.workerType ? eq(vendors.workerType, filter.workerType) : undefined,
        filter.paySchedule ? eq(vendors.paySchedule, filter.paySchedule) : undefined,
      ),
    )
    .orderBy(asc(vendors.displayName));
  return rows
    .filter((r) => r.workerType !== 'not_a_worker')
    .map((r) => ({
      vendorId: r.id,
      displayName: r.displayName,
      workerType: r.workerType,
      payRate: r.payRate,
      payRateBasis: r.payRateBasis,
      paySchedule: r.paySchedule,
      defaultExpenseAccountId: r.defaultExpenseAccountId,
    }));
}

// -- Get / list ------------------------------------------------------------

export async function listRuns(tx: Database) {
  return tx
    .select()
    .from(payrollRuns)
    .orderBy(desc(payrollRuns.payDate), desc(payrollRuns.createdAt));
}

export async function getRun(tx: Database, runId: string) {
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
  if (!run) return null;
  const lines = await tx
    .select({
      id: payrollRunLines.id,
      vendorId: payrollRunLines.vendorId,
      vendorName: vendors.displayName,
      workerTypeAtCreation: payrollRunLines.workerTypeAtCreation,
      hours: payrollRunLines.hours,
      rate: payrollRunLines.rate,
      gross: payrollRunLines.gross,
      federalIncomeTax: payrollRunLines.federalIncomeTax,
      socialSecurity: payrollRunLines.socialSecurity,
      medicare: payrollRunLines.medicare,
      stateIncomeTax: payrollRunLines.stateIncomeTax,
      otherDeductions: payrollRunLines.otherDeductions,
      net: payrollRunLines.net,
      memo: payrollRunLines.memo,
      postedPaymentId: payrollRunLines.postedPaymentId,
      createdAt: payrollRunLines.createdAt,
    })
    .from(payrollRunLines)
    .leftJoin(vendors, eq(vendors.id, payrollRunLines.vendorId))
    .where(eq(payrollRunLines.payrollRunId, runId))
    .orderBy(asc(payrollRunLines.createdAt));
  return { ...run, lines };
}

// -- Post ------------------------------------------------------------------

interface PostResult {
  runId: string;
  postedLines: number;
  paymentIds: string[];
}

export async function postPayrollRun(
  tx: Database,
  ctx: PayrollRunContext,
  runId: string,
): Promise<PostResult> {
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
  if (!run) throw new PayrollRunError(`run ${runId} not found`, 'not_found');
  if (run.status !== 'draft') {
    throw new PayrollRunError(
      `run is ${run.status}; only drafts can be posted`,
      'wrong_status',
    );
  }
  if (!run.bankAccountId) {
    throw new PayrollRunError(
      'pick a bank account before posting (used for the check)',
      'no_bank_account',
    );
  }

  const lines = await tx
    .select()
    .from(payrollRunLines)
    .where(eq(payrollRunLines.payrollRunId, runId))
    .orderBy(asc(payrollRunLines.createdAt));
  if (lines.length === 0) {
    throw new PayrollRunError('run has no lines', 'no_lines');
  }

  // Validate the bank account exists + active.
  const [bank] = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.id, run.bankAccountId));
  if (!bank || !bank.isActive) {
    throw new PayrollRunError('bank account is missing or inactive', 'unknown_account');
  }

  const memo = `Payroll period ${run.periodStart} to ${run.periodEnd}`;
  const paymentIds: string[] = [];

  for (const line of lines) {
    // Resolve the per-line expense account: vendor.defaultExpenseAccountId,
    // else first active expense account on the COA, else fail.
    const [vendor] = await tx
      .select({
        id: vendors.id,
        displayName: vendors.displayName,
        defaultExpenseAccountId: vendors.defaultExpenseAccountId,
      })
      .from(vendors)
      .where(eq(vendors.id, line.vendorId));
    if (!vendor) {
      throw new PayrollRunError(`vendor ${line.vendorId} on line missing`, 'unknown_vendor');
    }
    let expenseAccountId = vendor.defaultExpenseAccountId;
    if (!expenseAccountId) {
      const [fallback] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.type, 'expense'), eq(accounts.isActive, true)))
        .orderBy(accounts.code)
        .limit(1);
      if (!fallback) {
        throw new PayrollRunError(
          `worker ${vendor.displayName} has no default expense account and the COA has no active expense account`,
          'unknown_account',
        );
      }
      expenseAccountId = fallback.id;
    }

    // 1) Build a salaries-style bill for this line (NET amount, since
    //    KPBooks doesn't post withholdings to liability accounts).
    let billId: string;
    try {
      const billRes = await createBill(
        tx,
        { companyId: ctx.companyId, userId: ctx.userId },
        {
          vendorId: line.vendorId,
          billNumber: `PAY-${run.id.replace(/-/g, '').slice(0, 6)}-${line.id.replace(/-/g, '').slice(0, 6)}`,
          billDate: run.payDate,
          memo,
          lines: [
            {
              accountId: expenseAccountId,
              description: `${vendor.displayName} payroll ${run.periodStart} - ${run.periodEnd}`,
              quantity: '1',
              unitPrice: line.net,
            },
          ],
        },
      );
      billId = billRes.id;
    } catch (err) {
      if (err instanceof BillError) {
        throw new PayrollRunError(
          `bill creation failed for ${vendor.displayName}: ${err.message}`,
          'bill_failed',
        );
      }
      throw err;
    }

    // 2) Create a payment that fully applies to that bill.
    let paymentId: string;
    try {
      const payRes = await createPayment(
        tx,
        { companyId: ctx.companyId, userId: ctx.userId },
        {
          paymentType: 'vendor_sent',
          vendorId: line.vendorId,
          paymentDate: run.payDate,
          paymentMethod: 'check',
          bankAccountId: run.bankAccountId,
          amount: line.net,
          memo,
          applications: [{ billId, amount: line.net }],
        },
      );
      paymentId = payRes.id;
    } catch (err) {
      if (err instanceof PaymentError) {
        throw new PayrollRunError(
          `payment creation failed for ${vendor.displayName}: ${err.message}`,
          'payment_failed',
        );
      }
      throw err;
    }

    // 3) Stamp the line. The lock-after-post trigger allows ONLY the
    //    posted_payment_id field to change after the run flips to posted,
    //    so we set it here BEFORE the status flip below.
    await tx
      .update(payrollRunLines)
      .set({ postedPaymentId: paymentId })
      .where(eq(payrollRunLines.id, line.id));
    paymentIds.push(paymentId);
  }

  await tx
    .update(payrollRuns)
    .set({ status: 'posted', postedAt: new Date(), updatedAt: new Date() })
    .where(eq(payrollRuns.id, runId));

  return { runId, postedLines: lines.length, paymentIds };
}

// -- Void ------------------------------------------------------------------

export async function voidPayrollRun(
  tx: Database,
  ctx: PayrollRunContext,
  runId: string,
): Promise<{ runId: string; voidedLines: number }> {
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
  if (!run) throw new PayrollRunError(`run ${runId} not found`, 'not_found');
  if (run.status !== 'posted') {
    throw new PayrollRunError(`run is ${run.status}; only posted runs can be voided`, 'wrong_status');
  }
  const lines = await tx
    .select({ id: payrollRunLines.id, postedPaymentId: payrollRunLines.postedPaymentId })
    .from(payrollRunLines)
    .where(eq(payrollRunLines.payrollRunId, runId));

  const today = new Date().toISOString().slice(0, 10);
  const voidMemo = `Voided payroll run ${run.id.slice(0, 8)}`;
  let voided = 0;
  for (const line of lines) {
    if (!line.postedPaymentId) continue;
    // Void the payment (this writes a reversing JE for the cash side AND
    // re-opens the bill via existing void-payment logic).
    try {
      await voidPayment(
        tx,
        { companyId: ctx.companyId, userId: ctx.userId },
        line.postedPaymentId,
        { voidDate: today, memo: voidMemo },
      );
    } catch (err) {
      if (err instanceof PaymentError && err.code !== 'already_voided') throw err;
    }
    voided += 1;
  }

  // Best-effort void of every PAY-* bill we created -- safe to skip if any
  // already voided. We look them up by billNumber prefix on this run.
  const billRows = await tx.execute(sql`
    SELECT id FROM bills
     WHERE bill_number LIKE ${'PAY-' + run.id.replace(/-/g, '').slice(0, 6) + '-%'}
       AND status <> 'void'
  `);
  for (const r of billRows as unknown as Array<{ id: string }>) {
    try {
      await voidBill(tx, { companyId: ctx.companyId, userId: ctx.userId }, r.id, {
        voidDate: today,
        memo: voidMemo,
      });
    } catch (err) {
      if (err instanceof BillError && err.code !== 'already_voided') throw err;
    }
  }

  // Note: payroll_run_lines.posted_payment_id is set to NULL by the
  // payments FK ON DELETE set null... but we don't delete payments, we
  // void them. So the FK stays. That's fine -- the line still references
  // the (now voided) payment for audit purposes. The lock-after-post
  // trigger uses parent_status to keep lines locked even after void.

  await tx
    .update(payrollRuns)
    .set({ status: 'voided', voidedAt: new Date(), updatedAt: new Date() })
    .where(eq(payrollRuns.id, runId));

  return { runId, voidedLines: voided };
}

void inArray; // kept import for future bulk-line operations
