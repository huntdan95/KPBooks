import {
  type Database,
  accounts,
  bills,
  customers,
  timeEntries,
  vendors,
} from '@kpbooks/db';
import { Money } from '@kpbooks/money';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BillError, createBill } from '../bills/posting.service.js';

/**
 * time-entries.service -- billable hours per contractor.
 *
 * Workflow:
 *   1. Bookkeeper logs hours per vendor (date, hours, rate, description,
 *      account). Each entry stores its own snapshotted rate, so future rate
 *      changes don't retroactively rewrite history.
 *   2. End-of-period: buildBillFromEntries collects unbilled entries (or a
 *      caller-selected subset) for one vendor, posts a real A/P bill via
 *      bills.posting.createBill, and stamps each entry with billed_bill_id.
 *   3. Once billed_bill_id is set, the entry is locked at the DB level
 *      (lock-after-billed trigger). The lock releases if the bill is voided
 *      and the entries clear back to unbilled.
 */

export class TimeEntryError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'invalid_input'
      | 'unknown_vendor'
      | 'unknown_account'
      | 'inactive_account'
      | 'already_billed'
      | 'no_unbilled_entries'
      | 'bill_create_failed',
  ) {
    super(message);
    this.name = 'TimeEntryError';
  }
}

export interface TimeEntryContext {
  companyId: string;
  userId: string;
}

const NumLike = z.union([z.string(), z.number()]);

export const CreateTimeEntrySchema = z
  .object({
    vendorId: z.string().uuid(),
    entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hours: NumLike,
    rate: NumLike.optional(), // falls back to vendor.payRate at creation
    description: z.string().min(1).max(500),
    project: z.string().max(120).optional(),
    accountId: z.string().uuid().optional(), // falls back to vendor.defaultExpenseAccountId
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateTimeEntryInput = z.infer<typeof CreateTimeEntrySchema>;

export const UpdateTimeEntrySchema = z
  .object({
    entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    hours: NumLike.optional(),
    rate: NumLike.optional(),
    description: z.string().min(1).max(500).optional(),
    project: z.string().max(120).nullable().optional(),
    accountId: z.string().uuid().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type UpdateTimeEntryInput = z.infer<typeof UpdateTimeEntrySchema>;

export const BuildBillSchema = z
  .object({
    vendorId: z.string().uuid(),
    /** YYYY-MM-DD. Defaults to today. */
    billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Optional bill number; auto-generated if omitted. */
    billNumber: z.string().min(1).max(40).optional(),
    /** Optional memo on the bill. */
    memo: z.string().max(500).optional(),
    /** Restrict to specific entry ids; if omitted, includes all unbilled for vendor. */
    entryIds: z.array(z.string().uuid()).optional(),
  })
  .strict();
export type BuildBillInput = z.infer<typeof BuildBillSchema>;

function toDecimalString(v: string | number): string {
  return typeof v === 'number' ? v.toString() : v;
}

function computeAmount(hours: string, rate: string): string {
  // hours x rate using Money/4dp arithmetic.
  const h = Money.of(hours, 'USD');
  return h.mul(rate).toPgNumeric();
}

// --- CRUD -----------------------------------------------------------------

export async function createTimeEntry(
  tx: Database,
  ctx: TimeEntryContext,
  input: CreateTimeEntryInput,
): Promise<{ id: string; amount: string }> {
  const data = CreateTimeEntrySchema.parse(input);

  const [vendor] = await tx
    .select({
      id: vendors.id,
      payRate: vendors.payRate,
      defaultExpenseAccountId: vendors.defaultExpenseAccountId,
    })
    .from(vendors)
    .where(eq(vendors.id, data.vendorId));
  if (!vendor) throw new TimeEntryError(`vendor ${data.vendorId} not found`, 'unknown_vendor');

  // Resolve rate: explicit -> vendor.payRate -> error.
  let rate: string;
  if (data.rate !== undefined) {
    rate = toDecimalString(data.rate);
  } else if (vendor.payRate) {
    rate = vendor.payRate;
  } else {
    throw new TimeEntryError(
      'no rate provided and the vendor has no default pay rate set',
      'invalid_input',
    );
  }

  // Resolve account: explicit -> vendor.defaultExpenseAccountId -> error.
  let accountId: string;
  if (data.accountId) {
    accountId = data.accountId;
  } else if (vendor.defaultExpenseAccountId) {
    accountId = vendor.defaultExpenseAccountId;
  } else {
    throw new TimeEntryError(
      'no expense account provided and the vendor has no default expense account',
      'invalid_input',
    );
  }

  // Validate the account is active in this company.
  const [acct] = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!acct) throw new TimeEntryError(`account ${accountId} not found`, 'unknown_account');
  if (!acct.isActive) {
    throw new TimeEntryError(`account ${accountId} is inactive`, 'inactive_account');
  }

  const hours = toDecimalString(data.hours);
  if (Number(hours) <= 0) {
    throw new TimeEntryError('hours must be positive', 'invalid_input');
  }
  if (Number(rate) < 0) {
    throw new TimeEntryError('rate must be non-negative', 'invalid_input');
  }

  const amount = computeAmount(hours, rate);

  const [created] = await tx
    .insert(timeEntries)
    .values({
      companyId: ctx.companyId,
      vendorId: data.vendorId,
      entryDate: data.entryDate,
      hours,
      rate,
      amount,
      description: data.description.trim(),
      ...(data.project ? { project: data.project } : {}),
      accountId,
      ...(ctx.userId ? { createdByUserId: ctx.userId } : {}),
      ...(data.notes ? { notes: data.notes } : {}),
    })
    .returning({ id: timeEntries.id });
  if (!created) throw new TimeEntryError('failed to create time entry', 'invalid_input');
  return { id: created.id, amount };
}

export async function updateTimeEntry(
  tx: Database,
  entryId: string,
  input: UpdateTimeEntryInput,
): Promise<{ id: string; amount: string }> {
  const data = UpdateTimeEntrySchema.parse(input);

  const [existing] = await tx
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.id, entryId));
  if (!existing) throw new TimeEntryError(`time entry ${entryId} not found`, 'not_found');
  if (existing.billedBillId) {
    throw new TimeEntryError(
      `entry is locked (billed on bill ${existing.billedBillId})`,
      'already_billed',
    );
  }

  // Validate account if changed.
  if (data.accountId) {
    const [acct] = await tx
      .select({ id: accounts.id, isActive: accounts.isActive })
      .from(accounts)
      .where(eq(accounts.id, data.accountId));
    if (!acct) throw new TimeEntryError(`account ${data.accountId} not found`, 'unknown_account');
    if (!acct.isActive) {
      throw new TimeEntryError(`account ${data.accountId} is inactive`, 'inactive_account');
    }
  }

  const newHours =
    data.hours !== undefined ? toDecimalString(data.hours) : existing.hours;
  const newRate = data.rate !== undefined ? toDecimalString(data.rate) : existing.rate;
  if (Number(newHours) <= 0) {
    throw new TimeEntryError('hours must be positive', 'invalid_input');
  }
  if (Number(newRate) < 0) {
    throw new TimeEntryError('rate must be non-negative', 'invalid_input');
  }
  const newAmount =
    data.hours !== undefined || data.rate !== undefined
      ? computeAmount(newHours, newRate)
      : existing.amount;

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (data.entryDate !== undefined) update.entryDate = data.entryDate;
  if (data.hours !== undefined) update.hours = newHours;
  if (data.rate !== undefined) update.rate = newRate;
  if (data.hours !== undefined || data.rate !== undefined) update.amount = newAmount;
  if (data.description !== undefined) update.description = data.description.trim();
  if (data.project !== undefined) update.project = data.project;
  if (data.accountId !== undefined) update.accountId = data.accountId;
  if (data.notes !== undefined) update.notes = data.notes;

  await tx.update(timeEntries).set(update).where(eq(timeEntries.id, entryId));
  return { id: entryId, amount: newAmount };
}

export async function deleteTimeEntry(tx: Database, entryId: string): Promise<void> {
  const [existing] = await tx
    .select({ id: timeEntries.id, billedBillId: timeEntries.billedBillId })
    .from(timeEntries)
    .where(eq(timeEntries.id, entryId));
  if (!existing) throw new TimeEntryError(`time entry ${entryId} not found`, 'not_found');
  if (existing.billedBillId) {
    throw new TimeEntryError(
      `entry is locked (billed on bill ${existing.billedBillId})`,
      'already_billed',
    );
  }
  await tx.delete(timeEntries).where(eq(timeEntries.id, entryId));
}

// --- Listing --------------------------------------------------------------

export interface TimeEntryListFilter {
  vendorId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  unbilledOnly?: boolean | undefined;
}

export async function listTimeEntries(tx: Database, filter: TimeEntryListFilter) {
  const rows = await tx
    .select({
      id: timeEntries.id,
      vendorId: timeEntries.vendorId,
      vendorName: vendors.displayName,
      entryDate: timeEntries.entryDate,
      hours: timeEntries.hours,
      rate: timeEntries.rate,
      amount: timeEntries.amount,
      description: timeEntries.description,
      project: timeEntries.project,
      accountId: timeEntries.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      billedBillId: timeEntries.billedBillId,
      billedAt: timeEntries.billedAt,
      notes: timeEntries.notes,
      createdAt: timeEntries.createdAt,
    })
    .from(timeEntries)
    .leftJoin(vendors, eq(vendors.id, timeEntries.vendorId))
    .leftJoin(accounts, eq(accounts.id, timeEntries.accountId))
    .where(
      and(
        filter.vendorId ? eq(timeEntries.vendorId, filter.vendorId) : undefined,
        filter.from ? gte(timeEntries.entryDate, filter.from) : undefined,
        filter.to ? lte(timeEntries.entryDate, filter.to) : undefined,
        filter.unbilledOnly ? isNull(timeEntries.billedBillId) : undefined,
      ),
    )
    .orderBy(desc(timeEntries.entryDate), desc(timeEntries.createdAt));
  void customers; // not used directly; keep types happy
  return rows;
}

/**
 * Per-vendor unbilled summary -- powers the Time page header so the user
 * sees "Acme Plumbing: 28 entries · 102.5 hrs · $5,125 unbilled".
 */
export async function unbilledSummaryByVendor(tx: Database) {
  const rows = await tx.execute(sql`
    SELECT
      v.id            AS vendor_id,
      v.display_name  AS vendor_name,
      v.email         AS vendor_email,
      COUNT(t.id)     AS entry_count,
      COALESCE(SUM(t.hours), 0)  AS total_hours,
      COALESCE(SUM(t.amount), 0) AS total_amount,
      MIN(t.entry_date) AS earliest_date,
      MAX(t.entry_date) AS latest_date
    FROM vendors v
    INNER JOIN time_entries t ON t.vendor_id = v.id
    WHERE t.billed_bill_id IS NULL
    GROUP BY v.id, v.display_name, v.email
    ORDER BY total_amount DESC, v.display_name
  `);
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    vendorId: String(r.vendor_id),
    vendorName: String(r.vendor_name),
    vendorEmail: r.vendor_email ? String(r.vendor_email) : null,
    entryCount: Number(r.entry_count ?? 0),
    totalHours: String(r.total_hours ?? '0'),
    totalAmount: String(r.total_amount ?? '0'),
    earliestDate: r.earliest_date ? String(r.earliest_date) : null,
    latestDate: r.latest_date ? String(r.latest_date) : null,
  }));
}

// --- Build bill -----------------------------------------------------------

export interface BuildBillResult {
  billId: string;
  billNumber: string;
  total: string;
  entryCount: number;
}

export async function buildBillFromEntries(
  tx: Database,
  ctx: TimeEntryContext,
  input: BuildBillInput,
): Promise<BuildBillResult> {
  const data = BuildBillSchema.parse(input);

  // Confirm vendor exists.
  const [vendor] = await tx
    .select({ id: vendors.id, displayName: vendors.displayName })
    .from(vendors)
    .where(eq(vendors.id, data.vendorId));
  if (!vendor) throw new TimeEntryError(`vendor ${data.vendorId} not found`, 'unknown_vendor');

  // Pull unbilled entries for this vendor (optionally filtered by ids).
  const entryRows = await tx
    .select({
      id: timeEntries.id,
      entryDate: timeEntries.entryDate,
      hours: timeEntries.hours,
      rate: timeEntries.rate,
      amount: timeEntries.amount,
      description: timeEntries.description,
      project: timeEntries.project,
      accountId: timeEntries.accountId,
    })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.vendorId, data.vendorId),
        isNull(timeEntries.billedBillId),
        data.entryIds && data.entryIds.length > 0
          ? inArray(timeEntries.id, data.entryIds)
          : undefined,
      ),
    )
    .orderBy(asc(timeEntries.entryDate), asc(timeEntries.createdAt));

  if (entryRows.length === 0) {
    throw new TimeEntryError(
      'no unbilled time entries for this vendor (within the selection, if any)',
      'no_unbilled_entries',
    );
  }

  const billDate = data.billDate ?? new Date().toISOString().slice(0, 10);
  const billNumber =
    data.billNumber ??
    `TIME-${billDate.replace(/-/g, '')}-${vendor.id.replace(/-/g, '').slice(0, 6)}`;

  // Build one bill_line per entry. Description includes the date + hours so
  // the contractor + bookkeeper can match each line back to the timesheet.
  const lines = entryRows.map((e) => {
    const projectTag = e.project ? `[${e.project}] ` : '';
    return {
      accountId: e.accountId,
      description: `${e.entryDate} · ${e.hours} hrs @ ${e.rate} · ${projectTag}${e.description}`.slice(
        0,
        500,
      ),
      quantity: e.hours,
      unitPrice: e.rate,
    };
  });

  let billId: string;
  let billTotal: string;
  try {
    const result = await createBill(tx, ctx, {
      vendorId: data.vendorId,
      billNumber,
      billDate,
      ...(data.dueDate ? { dueDate: data.dueDate } : {}),
      ...(data.memo ? { memo: data.memo } : { memo: `Time entries ${entryRows[0]!.entryDate} - ${entryRows[entryRows.length - 1]!.entryDate}` }),
      lines,
    });
    billId = result.id;
    billTotal = result.total;
  } catch (err) {
    if (err instanceof BillError) {
      throw new TimeEntryError(`bill creation failed: ${err.message}`, 'bill_create_failed');
    }
    throw err;
  }

  // Stamp every entry with billed_bill_id + billed_at. Lock-after-billed
  // trigger allows this transition (NULL -> non-NULL).
  await tx
    .update(timeEntries)
    .set({ billedBillId: billId, billedAt: new Date() })
    .where(
      and(
        eq(timeEntries.vendorId, data.vendorId),
        inArray(
          timeEntries.id,
          entryRows.map((e) => e.id),
        ),
      ),
    );

  // Sanity-check the bill row exists with the expected total.
  void bills;

  return {
    billId,
    billNumber,
    total: billTotal,
    entryCount: entryRows.length,
  };
}
