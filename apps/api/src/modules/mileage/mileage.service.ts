import { type Database, accounts, mileageTrips } from '@kpbooks/db';
import { Money } from '@kpbooks/money';
import { and, asc, between, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordActivity } from '../activity/activity.service.js';
import { PostingError, postEntry } from '../ledger/posting.service.js';

/**
 * mileage.service -- per-trip log + batch posting.
 *
 * Trips are mutable while status='logged', frozen once status='posted'.
 * Posting batches every 'logged' trip in a date range into ONE journal
 * entry (DR Vehicle/Mileage Expense, CR Owner Reimbursement / chosen
 * credit account) and stamps each trip with the posted JE id.
 *
 * Rate-locking: each trip stores rate_per_mile + deduction at logging
 * time. Changing the company-wide default later doesn't recompute
 * historical trips -- IRS rate changes mid-year sometimes (2008/2011/
 * 2022), and re-computing past deductions silently would be wrong.
 */

const USD = 'USD';

export class MileageError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'invalid_input'
      | 'wrong_status'
      | 'unknown_account'
      | 'inactive_account'
      | 'cross_company_account'
      | 'no_trips'
      | 'posting_failed',
  ) {
    super(message);
    this.name = 'MileageError';
  }
}

export interface MileageContext {
  companyId: string;
  userId: string;
}

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const NumLike = z.union([z.string(), z.number()]);

export const CreateTripSchema = z
  .object({
    tripDate: DateOnly,
    miles: NumLike,
    purpose: z.string().min(1).max(500),
    /** Defaults to company's mileage_rate_default if omitted. */
    ratePerMile: NumLike.optional(),
    startLocation: z.string().max(200).optional(),
    endLocation: z.string().max(200).optional(),
    vehicle: z.string().max(120).optional(),
    startOdometer: NumLike.optional(),
    endOdometer: NumLike.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateTripInput = z.infer<typeof CreateTripSchema>;

export const UpdateTripSchema = z
  .object({
    tripDate: DateOnly.optional(),
    miles: NumLike.optional(),
    purpose: z.string().min(1).max(500).optional(),
    ratePerMile: NumLike.optional(),
    startLocation: z.string().max(200).nullable().optional(),
    endLocation: z.string().max(200).nullable().optional(),
    vehicle: z.string().max(120).nullable().optional(),
    startOdometer: NumLike.nullable().optional(),
    endOdometer: NumLike.nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type UpdateTripInput = z.infer<typeof UpdateTripSchema>;

export const PostMileageSchema = z
  .object({
    fromDate: DateOnly,
    toDate: DateOnly,
    expenseAccountId: z.string().uuid(),
    creditAccountId: z.string().uuid(),
    /** Posting date for the JE; defaults to toDate if omitted. */
    postingDate: DateOnly.optional(),
    memo: z.string().max(500).optional(),
  })
  .strict()
  .refine((d) => d.toDate >= d.fromDate, {
    message: 'toDate must be on or after fromDate',
    path: ['toDate'],
  })
  .refine((d) => d.expenseAccountId !== d.creditAccountId, {
    message: 'expense and credit accounts must differ',
    path: ['creditAccountId'],
  });
export type PostMileageInput = z.infer<typeof PostMileageSchema>;

// -- Read --------------------------------------------------------------------

export interface TripRow {
  id: string;
  tripDate: string;
  startLocation: string | null;
  endLocation: string | null;
  vehicle: string | null;
  miles: string;
  purpose: string;
  ratePerMile: string;
  deduction: string;
  status: 'logged' | 'posted';
  postedAt: string | null;
  postedJournalEntryId: string | null;
}

export async function listTrips(tx: Database): Promise<TripRow[]> {
  const rows = await tx
    .select()
    .from(mileageTrips)
    .orderBy(desc(mileageTrips.tripDate), asc(mileageTrips.id));
  return rows.map((r) => ({
    id: r.id,
    tripDate: r.tripDate,
    startLocation: r.startLocation,
    endLocation: r.endLocation,
    vehicle: r.vehicle,
    miles: r.miles,
    purpose: r.purpose,
    ratePerMile: r.ratePerMile,
    deduction: r.deduction,
    status: r.status,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    postedJournalEntryId: r.postedJournalEntryId,
  }));
}

// -- Write -------------------------------------------------------------------

async function getCompanyDefaultRate(tx: Database, companyId: string): Promise<string> {
  const rows = await tx.execute(sql`
    SELECT mileage_rate_default AS rate FROM companies WHERE id = ${companyId}::uuid
  `);
  const r = (rows as unknown as Array<Record<string, unknown>>)[0];
  return String(r?.rate ?? '0.670000');
}

function computeDeduction(miles: string | number, rate: string | number): string {
  return Money.of(miles, USD).mul(rate.toString()).toPgNumeric();
}

export async function createTrip(
  tx: Database,
  ctx: MileageContext,
  input: CreateTripInput,
): Promise<{ id: string }> {
  const milesM = Money.of(input.miles, USD);
  if (!milesM.isPositive()) {
    throw new MileageError('miles must be > 0', 'invalid_input');
  }
  const rateStr = input.ratePerMile
    ? String(input.ratePerMile)
    : await getCompanyDefaultRate(tx, ctx.companyId);
  if (Number(rateStr) <= 0) {
    throw new MileageError('rate_per_mile must be > 0', 'invalid_input');
  }
  if (input.startOdometer !== undefined && input.endOdometer !== undefined) {
    if (Number(input.endOdometer) < Number(input.startOdometer)) {
      throw new MileageError('end_odometer must be >= start_odometer', 'invalid_input');
    }
  }

  const deduction = computeDeduction(input.miles, rateStr);

  const [row] = await tx
    .insert(mileageTrips)
    .values({
      companyId: ctx.companyId,
      tripDate: input.tripDate,
      miles: milesM.toPgNumeric(),
      purpose: input.purpose,
      ratePerMile: rateStr,
      deduction,
      startLocation: input.startLocation ?? null,
      endLocation: input.endLocation ?? null,
      vehicle: input.vehicle ?? null,
      startOdometer:
        input.startOdometer !== undefined ? String(input.startOdometer) : null,
      endOdometer:
        input.endOdometer !== undefined ? String(input.endOdometer) : null,
      notes: input.notes ?? null,
      createdByUserId: ctx.userId,
    })
    .returning({ id: mileageTrips.id });
  if (!row) throw new MileageError('failed to insert trip', 'invalid_input');
  return { id: row.id };
}

export async function updateTrip(
  tx: Database,
  id: string,
  input: UpdateTripInput,
): Promise<void> {
  const [existing] = await tx.select().from(mileageTrips).where(eq(mileageTrips.id, id));
  if (!existing) throw new MileageError('trip not found', 'not_found');
  if (existing.status !== 'logged') {
    throw new MileageError(
      `trip is ${existing.status} -- cannot edit`,
      'wrong_status',
    );
  }

  const update: Record<string, unknown> = {};
  if (input.tripDate !== undefined) update.tripDate = input.tripDate;
  if (input.miles !== undefined) update.miles = String(input.miles);
  if (input.purpose !== undefined) update.purpose = input.purpose;
  if (input.ratePerMile !== undefined) update.ratePerMile = String(input.ratePerMile);
  if (input.startLocation !== undefined) update.startLocation = input.startLocation;
  if (input.endLocation !== undefined) update.endLocation = input.endLocation;
  if (input.vehicle !== undefined) update.vehicle = input.vehicle;
  if (input.startOdometer !== undefined) {
    update.startOdometer =
      input.startOdometer === null ? null : String(input.startOdometer);
  }
  if (input.endOdometer !== undefined) {
    update.endOdometer = input.endOdometer === null ? null : String(input.endOdometer);
  }
  if (input.notes !== undefined) update.notes = input.notes;

  // Recompute deduction if miles or rate changed.
  const newMiles = (update.miles as string | undefined) ?? existing.miles;
  const newRate = (update.ratePerMile as string | undefined) ?? existing.ratePerMile;
  if (update.miles !== undefined || update.ratePerMile !== undefined) {
    update.deduction = computeDeduction(newMiles, newRate);
  }

  if (Object.keys(update).length === 0) return;
  update.updatedAt = new Date();
  await tx.update(mileageTrips).set(update).where(eq(mileageTrips.id, id));
}

export async function deleteTrip(tx: Database, id: string): Promise<void> {
  const [existing] = await tx
    .select({ status: mileageTrips.status })
    .from(mileageTrips)
    .where(eq(mileageTrips.id, id));
  if (!existing) throw new MileageError('trip not found', 'not_found');
  if (existing.status !== 'logged') {
    throw new MileageError(
      `trip is ${existing.status} -- cannot delete (already on a posted JE)`,
      'wrong_status',
    );
  }
  await tx.delete(mileageTrips).where(eq(mileageTrips.id, id));
}

// -- Posting -----------------------------------------------------------------

export interface PostMileageResult {
  journalEntryId: string;
  tripCount: number;
  totalMiles: string;
  totalDeduction: string;
}

async function assertAccountUsable(
  tx: Database,
  ctx: MileageContext,
  accountId: string,
): Promise<void> {
  const [a] = await tx
    .select({
      id: accounts.id,
      companyId: accounts.companyId,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!a) throw new MileageError(`unknown account ${accountId}`, 'unknown_account');
  if (a.companyId !== ctx.companyId) {
    throw new MileageError(
      `account ${accountId} belongs to another company`,
      'cross_company_account',
    );
  }
  if (!a.isActive) {
    throw new MileageError(`account ${accountId} is inactive`, 'inactive_account');
  }
}

export async function postMileage(
  tx: Database,
  ctx: MileageContext,
  input: PostMileageInput,
): Promise<PostMileageResult> {
  await assertAccountUsable(tx, ctx, input.expenseAccountId);
  await assertAccountUsable(tx, ctx, input.creditAccountId);

  const candidateTrips = await tx
    .select()
    .from(mileageTrips)
    .where(
      and(
        eq(mileageTrips.status, 'logged'),
        between(mileageTrips.tripDate, input.fromDate, input.toDate),
      ),
    );
  if (candidateTrips.length === 0) {
    throw new MileageError(
      `no logged trips between ${input.fromDate} and ${input.toDate}`,
      'no_trips',
    );
  }

  let totalDeductionM = Money.zero(USD);
  let totalMilesM = Money.zero(USD);
  for (const t of candidateTrips) {
    totalDeductionM = totalDeductionM.add(Money.of(t.deduction, USD));
    totalMilesM = totalMilesM.add(Money.of(t.miles, USD));
  }
  if (!totalDeductionM.isPositive()) {
    throw new MileageError('total deduction is zero -- nothing to post', 'no_trips');
  }

  const postingDate = input.postingDate ?? input.toDate;
  const memo =
    input.memo ?? `Mileage reimbursement: ${candidateTrips.length} trip(s) ${input.fromDate} to ${input.toDate}`;

  let entryId: string;
  try {
    const result = await postEntry(tx, ctx, {
      entryDate: postingDate,
      sourceType: 'manual',
      memo,
      reference: `MILEAGE-${input.fromDate}-${input.toDate}`,
      lines: [
        {
          accountId: input.expenseAccountId,
          debit: totalDeductionM.toPgNumeric(),
          currency: USD,
          fxRate: '1',
        },
        {
          accountId: input.creditAccountId,
          credit: totalDeductionM.toPgNumeric(),
          currency: USD,
          fxRate: '1',
        },
      ],
    });
    entryId = result.id;
  } catch (err) {
    if (err instanceof PostingError) {
      throw new MileageError(`posting failed: ${err.message}`, 'posting_failed');
    }
    throw err;
  }

  // Stamp every trip with status='posted' + the JE id, atomic with the JE.
  const tripIds = candidateTrips.map((t) => t.id);
  await tx
    .update(mileageTrips)
    .set({
      status: 'posted',
      postedJournalEntryId: entryId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(inArray(mileageTrips.id, tripIds));

  await recordActivity(
    tx,
    { companyId: ctx.companyId, userId: ctx.userId },
    {
      action: 'posted_mileage',
      entityType: 'journal_entry',
      entityId: entryId,
      summary: `Posted mileage reimbursement: ${candidateTrips.length} trip(s) for ${totalMilesM.toPgNumeric()} mi = ${totalDeductionM.toPgNumeric()}`,
      details: {
        fromDate: input.fromDate,
        toDate: input.toDate,
        tripCount: candidateTrips.length,
        totalMiles: totalMilesM.toPgNumeric(),
        totalDeduction: totalDeductionM.toPgNumeric(),
        tripIds,
      },
    },
  );

  return {
    journalEntryId: entryId,
    tripCount: candidateTrips.length,
    totalMiles: totalMilesM.toPgNumeric(),
    totalDeduction: totalDeductionM.toPgNumeric(),
  };
}
