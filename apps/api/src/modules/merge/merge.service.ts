import {
  type Database,
  bills,
  customers,
  estimates,
  invoices,
  payments,
  payrollRunLines,
  recurringTemplates,
  timeEntries,
  vendors,
  w9UploadTokens,
  workerDocuments,
} from '@kpbooks/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordActivity } from '../activity/activity.service.js';

/**
 * merge.service -- consolidate duplicate customer or vendor records.
 *
 * The "loser" record's FK references are reassigned to the "winner" inside a
 * single transaction, then the loser row is deleted. Because RLS scopes every
 * UPDATE/DELETE to the current company, there's no risk of touching another
 * tenant's data even though the queries don't carry an explicit company_id
 * filter (the GUC takes care of it).
 *
 * Both merge operations record a single activity_log row at the end with the
 * reassigned counts per table -- so the auditor can see exactly what moved
 * and from which loser id, even after the loser row is gone.
 *
 * Out of scope: a "soft" merge that keeps the loser visible-but-archived;
 * undo (the merge is irreversible by design); merge-of-three+ at once.
 */

export class MergeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'invalid_input'
      | 'same_record'
      | 'cross_company'
      | 'delete_failed',
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

export interface MergeContext {
  companyId: string;
  userId: string;
}

export const MergeSchema = z
  .object({
    loserId: z.string().uuid(),
    winnerId: z.string().uuid(),
  })
  .strict()
  .refine((d) => d.loserId !== d.winnerId, {
    message: 'loserId and winnerId must differ',
    path: ['loserId'],
  });
export type MergeInput = z.infer<typeof MergeSchema>;

export interface MergeResult {
  loserId: string;
  loserName: string;
  winnerId: string;
  winnerName: string;
  reassigned: Record<string, number>;
}

// -- Customers --------------------------------------------------------------

export async function mergeCustomers(
  tx: Database,
  ctx: MergeContext,
  input: MergeInput,
): Promise<MergeResult> {
  if (input.loserId === input.winnerId) {
    throw new MergeError('cannot merge a customer into itself', 'same_record');
  }

  const [loser] = await tx
    .select({ id: customers.id, displayName: customers.displayName })
    .from(customers)
    .where(eq(customers.id, input.loserId));
  if (!loser) {
    throw new MergeError(`customer ${input.loserId} not found`, 'not_found');
  }
  const [winner] = await tx
    .select({ id: customers.id, displayName: customers.displayName })
    .from(customers)
    .where(eq(customers.id, input.winnerId));
  if (!winner) {
    throw new MergeError(`customer ${input.winnerId} not found`, 'not_found');
  }

  const reassigned: Record<string, number> = {};

  const estResult = await tx
    .update(estimates)
    .set({ customerId: input.winnerId })
    .where(eq(estimates.customerId, input.loserId));
  reassigned.estimates = countOf(estResult);

  const invResult = await tx
    .update(invoices)
    .set({ customerId: input.winnerId })
    .where(eq(invoices.customerId, input.loserId));
  reassigned.invoices = countOf(invResult);

  const payResult = await tx
    .update(payments)
    .set({ customerId: input.winnerId })
    .where(eq(payments.customerId, input.loserId));
  reassigned.payments = countOf(payResult);

  // Recurring invoice templates store customerId in JSONB payload, not as a
  // FK column. Update via jsonb_set; RLS restricts to current company.
  const recResult = await tx.execute(sql`
    UPDATE recurring_templates
       SET payload    = jsonb_set(payload, '{customerId}', to_jsonb(${input.winnerId}::text), false),
           updated_at = now()
     WHERE kind = 'invoice'
       AND payload->>'customerId' = ${input.loserId}
  `);
  reassigned.recurring_templates = countOf(recResult);

  // Now safe to delete the loser -- every FK reference has moved.
  const delResult = await tx.delete(customers).where(eq(customers.id, input.loserId));
  if (countOf(delResult) === 0) {
    throw new MergeError(
      `failed to delete customer ${input.loserId} (FK still referencing somewhere?)`,
      'delete_failed',
    );
  }

  await recordActivity(
    tx,
    { companyId: ctx.companyId, userId: ctx.userId },
    {
      action: 'merged_customer',
      entityType: 'customer',
      entityId: input.winnerId,
      summary: `Merged customer "${loser.displayName}" into "${winner.displayName}"`,
      details: {
        loserId: input.loserId,
        loserName: loser.displayName,
        winnerId: input.winnerId,
        winnerName: winner.displayName,
        reassigned,
      },
    },
  );

  return {
    loserId: input.loserId,
    loserName: loser.displayName,
    winnerId: input.winnerId,
    winnerName: winner.displayName,
    reassigned,
  };
}

// -- Vendors ----------------------------------------------------------------

export async function mergeVendors(
  tx: Database,
  ctx: MergeContext,
  input: MergeInput,
): Promise<MergeResult> {
  if (input.loserId === input.winnerId) {
    throw new MergeError('cannot merge a vendor into itself', 'same_record');
  }

  const [loser] = await tx
    .select({ id: vendors.id, displayName: vendors.displayName })
    .from(vendors)
    .where(eq(vendors.id, input.loserId));
  if (!loser) {
    throw new MergeError(`vendor ${input.loserId} not found`, 'not_found');
  }
  const [winner] = await tx
    .select({ id: vendors.id, displayName: vendors.displayName })
    .from(vendors)
    .where(eq(vendors.id, input.winnerId));
  if (!winner) {
    throw new MergeError(`vendor ${input.winnerId} not found`, 'not_found');
  }

  const reassigned: Record<string, number> = {};

  const billResult = await tx
    .update(bills)
    .set({ vendorId: input.winnerId })
    .where(eq(bills.vendorId, input.loserId));
  reassigned.bills = countOf(billResult);

  const payResult = await tx
    .update(payments)
    .set({ vendorId: input.winnerId })
    .where(eq(payments.vendorId, input.loserId));
  reassigned.payments = countOf(payResult);

  const lineResult = await tx
    .update(payrollRunLines)
    .set({ vendorId: input.winnerId })
    .where(eq(payrollRunLines.vendorId, input.loserId));
  reassigned.payroll_run_lines = countOf(lineResult);

  const teResult = await tx
    .update(timeEntries)
    .set({ vendorId: input.winnerId })
    .where(eq(timeEntries.vendorId, input.loserId));
  reassigned.time_entries = countOf(teResult);

  // worker_documents and w9_upload_tokens have ON DELETE CASCADE FKs to
  // vendors, so without explicit reassignment they'd vanish when we delete
  // the loser. Reassign them so the winner inherits the W-9s and tokens
  // (semantically the right outcome -- the winner subsumes the loser's
  // identity, including its uploaded paperwork).
  const wdResult = await tx
    .update(workerDocuments)
    .set({ vendorId: input.winnerId })
    .where(eq(workerDocuments.vendorId, input.loserId));
  reassigned.worker_documents = countOf(wdResult);

  const w9Result = await tx
    .update(w9UploadTokens)
    .set({ vendorId: input.winnerId })
    .where(and(eq(w9UploadTokens.vendorId, input.loserId)));
  reassigned.w9_upload_tokens = countOf(w9Result);

  // Recurring bill templates store vendorId in JSONB payload.
  const recResult = await tx.execute(sql`
    UPDATE recurring_templates
       SET payload    = jsonb_set(payload, '{vendorId}', to_jsonb(${input.winnerId}::text), false),
           updated_at = now()
     WHERE kind = 'bill'
       AND payload->>'vendorId' = ${input.loserId}
  `);
  reassigned.recurring_templates = countOf(recResult);

  const delResult = await tx.delete(vendors).where(eq(vendors.id, input.loserId));
  if (countOf(delResult) === 0) {
    throw new MergeError(
      `failed to delete vendor ${input.loserId} (FK still referencing somewhere?)`,
      'delete_failed',
    );
  }

  await recordActivity(
    tx,
    { companyId: ctx.companyId, userId: ctx.userId },
    {
      action: 'merged_vendor',
      entityType: 'vendor',
      entityId: input.winnerId,
      summary: `Merged vendor "${loser.displayName}" into "${winner.displayName}"`,
      details: {
        loserId: input.loserId,
        loserName: loser.displayName,
        winnerId: input.winnerId,
        winnerName: winner.displayName,
        reassigned,
      },
    },
  );

  return {
    loserId: input.loserId,
    loserName: loser.displayName,
    winnerId: input.winnerId,
    winnerName: winner.displayName,
    reassigned,
  };
}

/**
 * Drizzle's update/delete return values vary by driver. The Neon driver in
 * this repo returns an object with rowCount; this helper coerces safely.
 */
function countOf(result: unknown): number {
  if (
    result &&
    typeof result === 'object' &&
    'rowCount' in result &&
    typeof (result as { rowCount: unknown }).rowCount === 'number'
  ) {
    return (result as { rowCount: number }).rowCount;
  }
  if (Array.isArray(result)) return result.length;
  return 0;
}
