import { type Database, accounts, fixedAssets, journalEntries } from '@kpbooks/db';
import { Money } from '@kpbooks/money';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PostingError, postEntry } from '../ledger/posting.service.js';

/**
 * fixed-assets.service -- the depreciation register.
 *
 * One row per capitalized asset. Straight-line monthly depreciation: the
 * service posts one JE per asset-month (DR depreciation expense, CR
 * accumulated depreciation) on the LAST day of each month from the
 * in-service month through the requested through-date, capped at the
 * useful-life total. Each JE goes through the existing posting service so
 * the deferred-balance trigger, RLS, and closed-period guard all fire.
 *
 * Depreciation history is queryable from journal_entries WHERE
 * source_type='manual' AND source_id=fixed_asset.id, with
 * reference='DEPR-<short>-<YYYY-MM>'. We also cache running totals on
 * fixed_assets (`accumulated_depreciation`, `last_depreciated_through`)
 * so the list view doesn't re-aggregate.
 *
 * Disposal: pick a date + cash account + proceeds + gain/loss account.
 * The service first runs depreciation through the disposal date, then
 * posts ONE final JE that zeroes accum, removes the asset cost, records
 * cash, and plugs gain/loss to the user-supplied account. Status flips
 * to 'disposed' and the row is read-only after that.
 */

const USD = 'USD';

export class FixedAssetError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'wrong_status'
      | 'invalid_input'
      | 'unknown_account'
      | 'inactive_account'
      | 'cross_company_account'
      | 'has_history'
      | 'fully_depreciated'
      | 'posting_failed',
  ) {
    super(message);
    this.name = 'FixedAssetError';
  }
}

export interface FixedAssetContext {
  companyId: string;
  userId: string;
}

// -- Schemas ---------------------------------------------------------------

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const NumLike = z.union([z.string(), z.number()]);

export const CreateFixedAssetSchema = z
  .object({
    name: z.string().min(1).max(200),
    category: z.string().max(100).optional(),
    description: z.string().max(2000).optional(),
    inServiceDate: DateOnly,
    cost: NumLike,
    salvageValue: NumLike.optional(),
    usefulLifeMonths: z.number().int().positive(),
    method: z.enum(['straight_line']).default('straight_line'),
    assetAccountId: z.string().uuid(),
    accumDeprAccountId: z.string().uuid(),
    deprExpenseAccountId: z.string().uuid(),
    memo: z.string().max(500).optional(),
  })
  .strict();
export type CreateFixedAssetInput = z.infer<typeof CreateFixedAssetSchema>;

export const UpdateFixedAssetSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    category: z.string().max(100).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    memo: z.string().max(500).nullable().optional(),
  })
  .strict();
export type UpdateFixedAssetInput = z.infer<typeof UpdateFixedAssetSchema>;

export const RunDepreciationSchema = z
  .object({
    /** Month-end date through which to post. The service rolls forward to
     *  the last day of the through-date's month if a non-month-end is given. */
    throughDate: DateOnly,
  })
  .strict();
export type RunDepreciationInput = z.infer<typeof RunDepreciationSchema>;

export const DisposeAssetSchema = z
  .object({
    disposalDate: DateOnly,
    /** Sale proceeds. 0 for junk/donate (write-off). */
    proceeds: NumLike,
    /** Where the cash hit (only used when proceeds > 0). */
    cashAccountId: z.string().uuid().optional(),
    /** Where the gain or loss plug posts. Required if proceeds != NBV. */
    gainLossAccountId: z.string().uuid().optional(),
    memo: z.string().max(500).optional(),
  })
  .strict();
export type DisposeAssetInput = z.infer<typeof DisposeAssetSchema>;

// -- Date helpers ----------------------------------------------------------

function lastDayOfMonth(yyyymmdd: string): string {
  const [y, m] = yyyymmdd.split('-').map((v) => Number(v));
  // First day of NEXT month, then back up one day.
  const next = new Date(Date.UTC(y!, m!, 1));
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

function firstDayOfMonth(yyyymmdd: string): string {
  return yyyymmdd.slice(0, 7) + '-01';
}

function addMonths(yyyymmdd: string, months: number): string {
  const [y, m, d] = yyyymmdd.split('-').map((v) => Number(v));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

function monthDiff(a: string, b: string): number {
  // months between first-of-month a and first-of-month b. b - a.
  const [ya, ma] = a.split('-').map((v) => Number(v));
  const [yb, mb] = b.split('-').map((v) => Number(v));
  return (yb! - ya!) * 12 + (mb! - ma!);
}

// -- Read --------------------------------------------------------------------

export interface FixedAssetListRow {
  id: string;
  name: string;
  category: string | null;
  inServiceDate: string;
  cost: string;
  salvageValue: string;
  usefulLifeMonths: number;
  method: 'straight_line';
  status: 'active' | 'disposed';
  accumulatedDepreciation: string;
  netBookValue: string;
  lastDepreciatedThrough: string | null;
  disposalDate: string | null;
  monthsRemaining: number;
}

export async function listFixedAssets(tx: Database): Promise<FixedAssetListRow[]> {
  const rows = await tx
    .select()
    .from(fixedAssets)
    .orderBy(desc(fixedAssets.inServiceDate), asc(fixedAssets.name));

  return rows.map((r) => {
    const cost = Money.of(r.cost, USD);
    const accum = Money.of(r.accumulatedDepreciation, USD);
    const nbv = cost.sub(accum);
    const monthsPosted = r.lastDepreciatedThrough
      ? monthDiff(firstDayOfMonth(r.inServiceDate), firstDayOfMonth(r.lastDepreciatedThrough)) +
        1
      : 0;
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      inServiceDate: r.inServiceDate,
      cost: r.cost,
      salvageValue: r.salvageValue,
      usefulLifeMonths: r.usefulLifeMonths,
      method: r.method,
      status: r.status,
      accumulatedDepreciation: r.accumulatedDepreciation,
      netBookValue: nbv.toPgNumeric(),
      lastDepreciatedThrough: r.lastDepreciatedThrough,
      disposalDate: r.disposalDate,
      monthsRemaining: Math.max(0, r.usefulLifeMonths - monthsPosted),
    };
  });
}

export interface FixedAssetDetail extends FixedAssetListRow {
  description: string | null;
  assetAccountId: string;
  accumDeprAccountId: string;
  deprExpenseAccountId: string;
  disposalProceeds: string | null;
  disposalCashAccountId: string | null;
  disposalJournalEntryId: string | null;
  memo: string | null;
  monthlyDepreciation: string;
  history: Array<{
    journalEntryId: string;
    entryDate: string;
    reference: string | null;
    memo: string | null;
    amount: string;
  }>;
}

export async function getFixedAsset(
  tx: Database,
  id: string,
): Promise<FixedAssetDetail | null> {
  const [row] = await tx.select().from(fixedAssets).where(eq(fixedAssets.id, id));
  if (!row) return null;

  const cost = Money.of(row.cost, USD);
  const salvage = Money.of(row.salvageValue, USD);
  const accum = Money.of(row.accumulatedDepreciation, USD);
  const monthly = cost.sub(salvage).div(row.usefulLifeMonths);
  const monthsPosted = row.lastDepreciatedThrough
    ? monthDiff(
        firstDayOfMonth(row.inServiceDate),
        firstDayOfMonth(row.lastDepreciatedThrough),
      ) + 1
    : 0;

  const history = await tx
    .select({
      journalEntryId: journalEntries.id,
      entryDate: journalEntries.entryDate,
      reference: journalEntries.reference,
      memo: journalEntries.memo,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.sourceType, 'manual'),
        eq(journalEntries.sourceId, id),
      ),
    )
    .orderBy(asc(journalEntries.entryDate));

  // Each JE for this asset is one of: DEPR-* or DISP-*. Pull the amount via
  // the line that posts to the depr_expense account (DEPR) or, for disposal,
  // simply mark amount=NBV at disposal time. Cheap: one extra query against
  // journal_lines. (Skipping for v1 -- the UI cell renders the reference and
  // entry date, which is enough to navigate.)
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    inServiceDate: row.inServiceDate,
    cost: row.cost,
    salvageValue: row.salvageValue,
    usefulLifeMonths: row.usefulLifeMonths,
    method: row.method,
    status: row.status,
    accumulatedDepreciation: row.accumulatedDepreciation,
    netBookValue: cost.sub(accum).toPgNumeric(),
    lastDepreciatedThrough: row.lastDepreciatedThrough,
    disposalDate: row.disposalDate,
    monthsRemaining: Math.max(0, row.usefulLifeMonths - monthsPosted),
    assetAccountId: row.assetAccountId,
    accumDeprAccountId: row.accumDeprAccountId,
    deprExpenseAccountId: row.deprExpenseAccountId,
    disposalProceeds: row.disposalProceeds,
    disposalCashAccountId: row.disposalCashAccountId,
    disposalJournalEntryId: row.disposalJournalEntryId,
    memo: row.memo,
    monthlyDepreciation: monthly.toPgNumeric(),
    history: history.map((h) => ({
      journalEntryId: h.journalEntryId,
      entryDate: h.entryDate,
      reference: h.reference,
      memo: h.memo,
      amount: '', // see comment above
    })),
  };
}

// -- Write -----------------------------------------------------------------

async function assertAccountUsable(
  tx: Database,
  ctx: FixedAssetContext,
  accountId: string,
  expectKind: 'asset' | 'expense' | 'any',
): Promise<void> {
  const [a] = await tx
    .select({
      id: accounts.id,
      companyId: accounts.companyId,
      isActive: accounts.isActive,
      type: accounts.type,
      subtype: accounts.subtype,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!a) throw new FixedAssetError(`unknown account ${accountId}`, 'unknown_account');
  if (a.companyId !== ctx.companyId) {
    throw new FixedAssetError(
      `account ${accountId} belongs to another company`,
      'cross_company_account',
    );
  }
  if (!a.isActive) {
    throw new FixedAssetError(`account ${accountId} is inactive`, 'inactive_account');
  }
  if (expectKind === 'asset' && a.type !== 'asset') {
    throw new FixedAssetError(
      `account ${accountId} must be an asset account (got type=${a.type})`,
      'invalid_input',
    );
  }
  if (expectKind === 'expense' && a.type !== 'expense') {
    throw new FixedAssetError(
      `account ${accountId} must be an expense account (got type=${a.type})`,
      'invalid_input',
    );
  }
}

export async function createFixedAsset(
  tx: Database,
  ctx: FixedAssetContext,
  input: CreateFixedAssetInput,
): Promise<{ id: string }> {
  const cost = Money.of(input.cost, USD);
  const salvage = Money.of(input.salvageValue ?? '0', USD);
  if (!cost.isPositive()) {
    throw new FixedAssetError('cost must be > 0', 'invalid_input');
  }
  if (salvage.isNegative()) {
    throw new FixedAssetError('salvage_value must be >= 0', 'invalid_input');
  }
  if (cost.cmp(salvage) <= 0) {
    throw new FixedAssetError('salvage_value must be < cost', 'invalid_input');
  }

  await assertAccountUsable(tx, ctx, input.assetAccountId, 'asset');
  await assertAccountUsable(tx, ctx, input.accumDeprAccountId, 'asset');
  await assertAccountUsable(tx, ctx, input.deprExpenseAccountId, 'expense');

  const [row] = await tx
    .insert(fixedAssets)
    .values({
      companyId: ctx.companyId,
      name: input.name,
      category: input.category ?? null,
      description: input.description ?? null,
      inServiceDate: input.inServiceDate,
      cost: cost.toPgNumeric(),
      salvageValue: salvage.toPgNumeric(),
      usefulLifeMonths: input.usefulLifeMonths,
      method: input.method,
      assetAccountId: input.assetAccountId,
      accumDeprAccountId: input.accumDeprAccountId,
      deprExpenseAccountId: input.deprExpenseAccountId,
      memo: input.memo ?? null,
      createdByUserId: ctx.userId,
    })
    .returning({ id: fixedAssets.id });

  if (!row) throw new FixedAssetError('failed to insert fixed asset', 'invalid_input');
  return { id: row.id };
}

export async function updateFixedAsset(
  tx: Database,
  id: string,
  input: UpdateFixedAssetInput,
): Promise<void> {
  const [row] = await tx
    .select({ status: fixedAssets.status })
    .from(fixedAssets)
    .where(eq(fixedAssets.id, id));
  if (!row) throw new FixedAssetError('fixed asset not found', 'not_found');
  if (row.status !== 'active') {
    throw new FixedAssetError(`fixed asset is ${row.status} -- cannot edit`, 'wrong_status');
  }
  // Only metadata fields are editable post-creation. Cost / life / accounts
  // are locked once the row exists, since editing them after any depreciation
  // has been posted would orphan the JE history. Future: allow edits when
  // accumulated_depreciation = 0 and last_depreciated_through IS NULL.
  await tx
    .update(fixedAssets)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.memo !== undefined && { memo: input.memo }),
      updatedAt: new Date(),
    })
    .where(eq(fixedAssets.id, id));
}

export async function deleteFixedAsset(tx: Database, id: string): Promise<void> {
  const [row] = await tx
    .select({
      status: fixedAssets.status,
      accumulated: fixedAssets.accumulatedDepreciation,
      lastThrough: fixedAssets.lastDepreciatedThrough,
    })
    .from(fixedAssets)
    .where(eq(fixedAssets.id, id));
  if (!row) throw new FixedAssetError('fixed asset not found', 'not_found');
  if (row.status !== 'active') {
    throw new FixedAssetError(
      `fixed asset is ${row.status} -- cannot delete`,
      'wrong_status',
    );
  }
  // Once any depreciation has been posted, deletion is no longer safe -- the
  // monthly JEs would be orphaned (sourceId would reference a missing row).
  // Force the user to dispose instead.
  if (Money.of(row.accumulated, USD).isPositive() || row.lastThrough !== null) {
    throw new FixedAssetError(
      'fixed asset has depreciation history -- dispose instead of delete',
      'has_history',
    );
  }
  await tx.delete(fixedAssets).where(eq(fixedAssets.id, id));
}

// -- Depreciation -----------------------------------------------------------

export interface RunDepreciationResult {
  assetId: string;
  monthsPosted: number;
  totalAmount: string;
  journalEntryIds: string[];
}

export async function runDepreciationForAsset(
  tx: Database,
  ctx: FixedAssetContext,
  assetId: string,
  throughDate: string,
): Promise<RunDepreciationResult> {
  const [asset] = await tx
    .select()
    .from(fixedAssets)
    .where(eq(fixedAssets.id, assetId));
  if (!asset) throw new FixedAssetError('fixed asset not found', 'not_found');
  if (asset.status !== 'active') {
    return { assetId, monthsPosted: 0, totalAmount: '0', journalEntryIds: [] };
  }

  const cost = Money.of(asset.cost, USD);
  const salvage = Money.of(asset.salvageValue, USD);
  const depreciable = cost.sub(salvage);
  if (!depreciable.isPositive()) {
    return { assetId, monthsPosted: 0, totalAmount: '0', journalEntryIds: [] };
  }

  const monthly = depreciable.div(asset.usefulLifeMonths);
  let accumulated = Money.of(asset.accumulatedDepreciation, USD);
  let monthsPosted = asset.lastDepreciatedThrough
    ? monthDiff(
        firstDayOfMonth(asset.inServiceDate),
        firstDayOfMonth(asset.lastDepreciatedThrough),
      ) + 1
    : 0;

  // First month to post: in-service month if never run, else the month AFTER
  // last_depreciated_through.
  let cursor: string;
  if (asset.lastDepreciatedThrough) {
    cursor = lastDayOfMonth(addMonths(asset.lastDepreciatedThrough, 1));
  } else {
    cursor = lastDayOfMonth(asset.inServiceDate);
  }
  // Roll the through-date forward to its month-end. We never depreciate a
  // partial month -- full-month convention is the simplest book-depreciation
  // approach and matches how QB treats months by default.
  const stopAt = lastDayOfMonth(throughDate);

  const journalEntryIds: string[] = [];
  const totalsThisRun: Money[] = [];
  const shortId = assetId.slice(0, 8);

  while (cursor <= stopAt && monthsPosted < asset.usefulLifeMonths) {
    // Don't depreciate beyond a disposal date (defensive; runDepreciation
    // before disposeAsset shouldn't happen for disposed assets, but in case
    // the caller passes a future throughDate after disposal).
    if (asset.disposalDate && cursor > asset.disposalDate) break;

    // Last-month true-up: if this is the final month of useful life, post
    // exactly the remainder rather than `monthly` to avoid rounding drift
    // (e.g. $10000 / 36 months = $277.7778 each, but accumulated must end
    // at exactly $10000).
    const isLastMonth = monthsPosted === asset.usefulLifeMonths - 1;
    const amount = isLastMonth ? depreciable.sub(accumulated) : monthly;

    if (!amount.isPositive()) break;

    const yyyymm = cursor.slice(0, 7);
    try {
      const result = await postEntry(tx, ctx, {
        entryDate: cursor,
        sourceType: 'manual',
        sourceId: assetId,
        memo: `Monthly depreciation: ${asset.name}`,
        reference: `DEPR-${shortId}-${yyyymm}`,
        lines: [
          {
            accountId: asset.deprExpenseAccountId,
            debit: amount.toPgNumeric(),
            currency: USD,
            fxRate: '1',
          },
          {
            accountId: asset.accumDeprAccountId,
            credit: amount.toPgNumeric(),
            currency: USD,
            fxRate: '1',
          },
        ],
      });
      journalEntryIds.push(result.id);
    } catch (err) {
      if (err instanceof PostingError) {
        throw new FixedAssetError(
          `posting failed for ${yyyymm}: ${err.message}`,
          'posting_failed',
        );
      }
      throw err;
    }

    accumulated = accumulated.add(amount);
    totalsThisRun.push(amount);
    monthsPosted++;

    // Update the cache columns inside the same tx; commits atomically with
    // the JE inserts above.
    await tx
      .update(fixedAssets)
      .set({
        accumulatedDepreciation: accumulated.toPgNumeric(),
        lastDepreciatedThrough: cursor,
        updatedAt: new Date(),
      })
      .where(eq(fixedAssets.id, assetId));

    cursor = lastDayOfMonth(addMonths(cursor, 1));
  }

  const total = totalsThisRun.reduce((acc, m) => acc.add(m), Money.zero(USD));
  return {
    assetId,
    monthsPosted: totalsThisRun.length,
    totalAmount: total.toPgNumeric(),
    journalEntryIds,
  };
}

export async function runDepreciationAll(
  tx: Database,
  ctx: FixedAssetContext,
  throughDate: string,
): Promise<RunDepreciationResult[]> {
  const rows = await tx
    .select({ id: fixedAssets.id })
    .from(fixedAssets)
    .where(eq(fixedAssets.status, 'active'));

  const results: RunDepreciationResult[] = [];
  for (const r of rows) {
    results.push(await runDepreciationForAsset(tx, ctx, r.id, throughDate));
  }
  return results;
}

// -- Disposal ---------------------------------------------------------------

export interface DisposeAssetResult {
  assetId: string;
  journalEntryId: string;
  netBookValue: string;
  gainLoss: string;
}

export async function disposeAsset(
  tx: Database,
  ctx: FixedAssetContext,
  assetId: string,
  input: DisposeAssetInput,
): Promise<DisposeAssetResult> {
  const [asset] = await tx
    .select()
    .from(fixedAssets)
    .where(eq(fixedAssets.id, assetId));
  if (!asset) throw new FixedAssetError('fixed asset not found', 'not_found');
  if (asset.status !== 'active') {
    throw new FixedAssetError(
      `fixed asset is ${asset.status} -- already disposed`,
      'wrong_status',
    );
  }
  if (input.disposalDate < asset.inServiceDate) {
    throw new FixedAssetError(
      'disposal_date must be on or after in_service_date',
      'invalid_input',
    );
  }

  // Step 1: catch up depreciation through the disposal month so the books
  // reflect every month the asset was held.
  await runDepreciationForAsset(tx, ctx, assetId, input.disposalDate);

  // Re-read after depreciation update.
  const [refreshed] = await tx
    .select()
    .from(fixedAssets)
    .where(eq(fixedAssets.id, assetId));
  if (!refreshed) throw new FixedAssetError('fixed asset vanished mid-tx', 'not_found');

  const cost = Money.of(refreshed.cost, USD);
  const accumulated = Money.of(refreshed.accumulatedDepreciation, USD);
  const nbv = cost.sub(accumulated);
  const proceeds = Money.of(input.proceeds, USD);
  if (proceeds.isNegative()) {
    throw new FixedAssetError('proceeds must be >= 0', 'invalid_input');
  }
  const gainLoss = proceeds.sub(nbv); // positive = gain, negative = loss

  // Validate the cash account if proceeds > 0.
  if (proceeds.isPositive()) {
    if (!input.cashAccountId) {
      throw new FixedAssetError(
        'cash_account_id is required when proceeds > 0',
        'invalid_input',
      );
    }
    await assertAccountUsable(tx, ctx, input.cashAccountId, 'any');
  }

  // Validate the gain/loss account if it'll be used.
  if (!gainLoss.isZero()) {
    if (!input.gainLossAccountId) {
      throw new FixedAssetError(
        'gain_loss_account_id is required when proceeds != book value',
        'invalid_input',
      );
    }
    await assertAccountUsable(tx, ctx, input.gainLossAccountId, 'any');
  }

  // Build balanced disposal JE.
  //   DR accumulated depreciation   (zero out the contra-asset)
  //   DR cash                        (proceeds, if any)
  //   DR loss   OR   CR gain         (the plug)
  //   CR fixed asset (cost)
  type Line = {
    accountId: string;
    debit?: string;
    credit?: string;
    currency: string;
    fxRate: string;
  };
  const lines: Line[] = [];
  if (accumulated.isPositive()) {
    lines.push({
      accountId: refreshed.accumDeprAccountId,
      debit: accumulated.toPgNumeric(),
      currency: USD,
      fxRate: '1',
    });
  }
  if (proceeds.isPositive()) {
    lines.push({
      accountId: input.cashAccountId!,
      debit: proceeds.toPgNumeric(),
      currency: USD,
      fxRate: '1',
    });
  }
  if (gainLoss.isPositive()) {
    // Gain on disposal -> credit (revenue side).
    lines.push({
      accountId: input.gainLossAccountId!,
      credit: gainLoss.toPgNumeric(),
      currency: USD,
      fxRate: '1',
    });
  } else if (gainLoss.isNegative()) {
    // Loss on disposal -> debit (expense side). abs() to flip sign.
    lines.push({
      accountId: input.gainLossAccountId!,
      debit: gainLoss.abs().toPgNumeric(),
      currency: USD,
      fxRate: '1',
    });
  }
  // Always: remove the asset cost.
  lines.push({
    accountId: refreshed.assetAccountId,
    credit: cost.toPgNumeric(),
    currency: USD,
    fxRate: '1',
  });

  if (lines.length < 2) {
    // Defensive: should never happen since cost > 0 always emits the asset
    // line, and if accumulated=0 and proceeds=0 then nbv=cost>0 -> loss line
    // emitted on the gain/loss row.
    throw new FixedAssetError(
      'disposal would emit a single-line JE',
      'invalid_input',
    );
  }

  const shortId = assetId.slice(0, 8);
  let entryId: string;
  try {
    const result = await postEntry(tx, ctx, {
      entryDate: input.disposalDate,
      sourceType: 'manual',
      sourceId: assetId,
      memo: input.memo ?? `Disposal: ${refreshed.name}`,
      reference: `DISP-${shortId}`,
      lines,
    });
    entryId = result.id;
  } catch (err) {
    if (err instanceof PostingError) {
      throw new FixedAssetError(`disposal posting failed: ${err.message}`, 'posting_failed');
    }
    throw err;
  }

  // Mark disposed.
  await tx
    .update(fixedAssets)
    .set({
      status: 'disposed',
      disposalDate: input.disposalDate,
      disposalProceeds: proceeds.toPgNumeric(),
      disposalCashAccountId: proceeds.isPositive() ? input.cashAccountId! : null,
      disposalJournalEntryId: entryId,
      updatedAt: new Date(),
    })
    .where(eq(fixedAssets.id, assetId));

  return {
    assetId,
    journalEntryId: entryId,
    netBookValue: nbv.toPgNumeric(),
    gainLoss: gainLoss.toPgNumeric(),
  };
}

// silence unused import warning if drizzle-orm sql isn't used in some shapes
void sql;
