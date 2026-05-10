import { type Database, activityLog, users } from '@kpbooks/db';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';

/**
 * activity.service -- the audit-trail recorder.
 *
 * recordActivity is called from inside other services' write paths so the
 * audit row is committed in the SAME transaction as the actual change. If
 * the action rolls back, the audit row rolls back too -- there's no
 * possibility of an audit log row referencing a change that never landed.
 *
 * The activity_log table is append-only at the DB layer (trigger in 0037);
 * there is no updateActivity / deleteActivity function on purpose.
 *
 * Slice #38 wires recordActivity only into postEntry, which captures every
 * journal-entry write (invoices, bills, payments, manual JEs, payroll
 * runs, depreciation, disposals, bank transactions, reconciliations).
 * Future slices will wire non-JE events (status flips, vendor edits,
 * deletions, login). action + entity_type are TEXT so adding a new event
 * category never requires a migration.
 */

export interface ActivityContext {
  companyId: string;
  /** May be null for system / cron events that have no end-user actor. */
  userId: string | null;
}

export interface RecordActivityInput {
  /** Lowercase snake_case verb, e.g. 'posted_entry', 'voided_payment'. */
  action: string;
  /** Lowercase snake_case singular noun, e.g. 'journal_entry', 'invoice'. */
  entityType: string;
  /** Null for company-wide events that don't tie to a specific row. */
  entityId?: string | null;
  /** One-line human-readable description for list views. */
  summary: string;
  /** Arbitrary structured context the UI can drill into. */
  details?: Record<string, unknown> | null;
}

export async function recordActivity(
  tx: Database,
  ctx: ActivityContext,
  input: RecordActivityInput,
): Promise<void> {
  if (!input.action.trim() || !input.entityType.trim() || !input.summary.trim()) {
    // Defensive: the DB CHECK constraints will also reject these, but
    // failing here gives a friendlier error if a caller passes empty strings.
    throw new Error('recordActivity: action, entityType, and summary must be non-empty');
  }
  await tx.insert(activityLog).values({
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    summary: input.summary,
    detailsJson: input.details ?? null,
  });
}

// -- Read --------------------------------------------------------------------

export const ListActivityQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .optional(),
  action: z.string().min(1).max(64).optional(),
  entityType: z.string().min(1).max(64).optional(),
  entityId: z.string().uuid().optional(),
  actorUserId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListActivityQuery = z.infer<typeof ListActivityQuerySchema>;

export interface ActivityRow {
  id: string;
  occurredAt: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  details: Record<string, unknown> | null;
  actorUserId: string | null;
  actorEmail: string | null;
}

export async function listActivity(
  tx: Database,
  filter: ListActivityQuery,
): Promise<ActivityRow[]> {
  const conditions = [];
  if (filter.from) {
    conditions.push(gte(activityLog.occurredAt, new Date(`${filter.from}T00:00:00Z`)));
  }
  if (filter.to) {
    // Inclusive upper bound at end-of-day UTC.
    conditions.push(lte(activityLog.occurredAt, new Date(`${filter.to}T23:59:59.999Z`)));
  }
  if (filter.action) conditions.push(eq(activityLog.action, filter.action));
  if (filter.entityType) conditions.push(eq(activityLog.entityType, filter.entityType));
  if (filter.entityId) conditions.push(eq(activityLog.entityId, filter.entityId));
  if (filter.actorUserId) conditions.push(eq(activityLog.actorUserId, filter.actorUserId));

  const rows = await tx
    .select({
      id: activityLog.id,
      occurredAt: activityLog.occurredAt,
      action: activityLog.action,
      entityType: activityLog.entityType,
      entityId: activityLog.entityId,
      summary: activityLog.summary,
      detailsJson: activityLog.detailsJson,
      actorUserId: activityLog.actorUserId,
      actorEmail: users.email,
    })
    .from(activityLog)
    .leftJoin(users, eq(users.id, activityLog.actorUserId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(activityLog.occurredAt))
    .limit(filter.limit);

  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt.toISOString(),
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    summary: r.summary,
    details: (r.detailsJson as Record<string, unknown> | null) ?? null,
    actorUserId: r.actorUserId,
    actorEmail: r.actorEmail,
  }));
}
