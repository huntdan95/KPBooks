import { type Database, recurringTemplates } from '@kpbooks/db';
import { and, asc, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { BillError, createBill } from '../bills/posting.service.js';
import { InvoiceError, createInvoice } from '../invoices/posting.service.js';
import {
  firstRunDate,
  generateRecurringNumber,
  isOnOrBefore,
  nextRunDate,
  parseIsoDate,
  todayIso,
  type Frequency,
  type Schedule,
} from './dates.js';

/**
 * recurring.service -- create / update / delete templates and fire them.
 *
 * Each fire resolves the template's payload through the existing invoice or
 * bill posting service, so the same validation + ledger writes happen as for
 * a one-off doc. The template tracks last_run_date / last_run_document_id /
 * run_count for audit + the UI's "fired N times, last on YYYY-MM-DD" line.
 */

// --- Schemas --------------------------------------------------------------

const PayloadLine = z.object({
  accountId: z.string().uuid(),
  description: z.string().min(1).max(500),
  quantity: z.union([z.string(), z.number()]).default('1'),
  unitPrice: z.union([z.string(), z.number()]).default('0'),
  taxable: z.boolean().default(false),
});

const InvoicePayload = z
  .object({
    customerId: z.string().uuid(),
    termsDays: z.number().int().min(0).max(365).optional(),
    memo: z.string().max(500).optional(),
    taxRateId: z.string().uuid().optional(),
    numberPrefix: z.string().max(10).optional(),
    lines: z.array(PayloadLine).min(1),
  })
  .strict();

const BillPayload = z
  .object({
    vendorId: z.string().uuid(),
    termsDays: z.number().int().min(0).max(365).optional(),
    memo: z.string().max(500).optional(),
    numberPrefix: z.string().max(10).optional(),
    lines: z.array(PayloadLine).min(1),
  })
  .strict();

export const CreateRecurringSchema = z
  .object({
    kind: z.enum(['invoice', 'bill']),
    name: z.string().min(1).max(120),
    frequency: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'annually']),
    /** 1..31; 31 = last day of month. Required for monthly/quarterly/annually. */
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    /** 0..6 (Sunday..Saturday). Required for weekly/biweekly. */
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    payload: z.union([InvoicePayload, BillPayload]),
  })
  .strict();

export type CreateRecurringInput = z.infer<typeof CreateRecurringSchema>;

export const UpdateRecurringSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    frequency: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'annually']).optional(),
    dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    nextRunDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    payload: z.union([InvoicePayload, BillPayload]).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type UpdateRecurringInput = z.infer<typeof UpdateRecurringSchema>;

export interface RecurringContext {
  companyId: string;
  userId: string;
}

export class RecurringError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'inactive'
      | 'past_end_date'
      | 'invalid_input'
      | 'invoice_failed'
      | 'bill_failed',
  ) {
    super(message);
    this.name = 'RecurringError';
  }
}

function scheduleFromInput(input: {
  frequency: Frequency;
  startDate: string;
  dayOfMonth?: number | null | undefined;
  dayOfWeek?: number | null | undefined;
}): Schedule {
  return {
    frequency: input.frequency,
    startDate: input.startDate,
    dayOfMonth: input.dayOfMonth ?? null,
    dayOfWeek: input.dayOfWeek ?? null,
  };
}

function validateScheduleShape(input: {
  frequency: Frequency;
  dayOfMonth?: number | null | undefined;
  dayOfWeek?: number | null | undefined;
}): void {
  if (input.frequency === 'weekly' || input.frequency === 'biweekly') {
    if (input.dayOfWeek == null) {
      throw new RecurringError(
        `${input.frequency} schedule requires dayOfWeek (0=Sun..6=Sat)`,
        'invalid_input',
      );
    }
  } else {
    if (input.dayOfMonth == null) {
      throw new RecurringError(
        `${input.frequency} schedule requires dayOfMonth (1..31; 31 = last day of month)`,
        'invalid_input',
      );
    }
  }
}

// --- CRUD -----------------------------------------------------------------

export async function createRecurring(
  tx: Database,
  ctx: RecurringContext,
  input: CreateRecurringInput,
): Promise<{ id: string; nextRunDate: string }> {
  const data = CreateRecurringSchema.parse(input);
  validateScheduleShape(data);

  // Sanity-check kind <-> payload shape. (zod union may have accepted the
  // "wrong" branch silently if the shape happens to type-match.)
  if (data.kind === 'invoice' && !('customerId' in data.payload)) {
    throw new RecurringError('invoice template payload must include customerId', 'invalid_input');
  }
  if (data.kind === 'bill' && !('vendorId' in data.payload)) {
    throw new RecurringError('bill template payload must include vendorId', 'invalid_input');
  }

  const next = firstRunDate(scheduleFromInput(data));
  if (data.endDate && !isOnOrBefore(next, data.endDate)) {
    throw new RecurringError(
      `first computed run-date (${next}) is after the end date (${data.endDate})`,
      'invalid_input',
    );
  }

  const insertValues: typeof recurringTemplates.$inferInsert = {
    companyId: ctx.companyId,
    kind: data.kind,
    name: data.name.trim(),
    frequency: data.frequency,
    startDate: data.startDate,
    nextRunDate: next,
    payload: data.payload as unknown as Record<string, unknown>,
    ...(data.dayOfMonth !== undefined ? { dayOfMonth: data.dayOfMonth } : {}),
    ...(data.dayOfWeek !== undefined ? { dayOfWeek: data.dayOfWeek } : {}),
    ...(data.endDate ? { endDate: data.endDate } : {}),
  };

  const [created] = await tx
    .insert(recurringTemplates)
    .values(insertValues)
    .returning({ id: recurringTemplates.id, nextRunDate: recurringTemplates.nextRunDate });
  if (!created) throw new RecurringError('failed to create template', 'invalid_input');
  return { id: created.id, nextRunDate: created.nextRunDate };
}

export async function updateRecurring(
  tx: Database,
  templateId: string,
  input: UpdateRecurringInput,
): Promise<void> {
  const data = UpdateRecurringSchema.parse(input);
  const [existing] = await tx
    .select()
    .from(recurringTemplates)
    .where(eq(recurringTemplates.id, templateId));
  if (!existing) throw new RecurringError(`template ${templateId} not found`, 'not_found');

  const merged = {
    frequency: data.frequency ?? existing.frequency,
    dayOfMonth: data.dayOfMonth === undefined ? existing.dayOfMonth : data.dayOfMonth,
    dayOfWeek: data.dayOfWeek === undefined ? existing.dayOfWeek : data.dayOfWeek,
    startDate: data.startDate ?? existing.startDate,
  };
  validateScheduleShape(merged);

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) update.name = data.name.trim();
  if (data.frequency !== undefined) update.frequency = data.frequency;
  if (data.dayOfMonth !== undefined) update.dayOfMonth = data.dayOfMonth;
  if (data.dayOfWeek !== undefined) update.dayOfWeek = data.dayOfWeek;
  if (data.startDate !== undefined) update.startDate = data.startDate;
  if (data.endDate !== undefined) update.endDate = data.endDate;
  if (data.nextRunDate !== undefined) update.nextRunDate = data.nextRunDate;
  if (data.payload !== undefined) update.payload = data.payload;
  if (data.isActive !== undefined) update.isActive = data.isActive;

  // If the schedule shape changed but the user didn't override nextRunDate,
  // recompute it from the new schedule + last_run_date (or startDate if never fired).
  if (
    data.nextRunDate === undefined &&
    (data.frequency !== undefined ||
      data.dayOfMonth !== undefined ||
      data.dayOfWeek !== undefined ||
      data.startDate !== undefined)
  ) {
    const sched = scheduleFromInput(merged);
    const recomputed = existing.lastRunDate
      ? nextRunDate(sched, existing.lastRunDate)
      : firstRunDate(sched);
    update.nextRunDate = recomputed;
  }

  await tx.update(recurringTemplates).set(update).where(eq(recurringTemplates.id, templateId));
}

export async function deleteRecurring(tx: Database, templateId: string): Promise<boolean> {
  const result = await tx
    .delete(recurringTemplates)
    .where(eq(recurringTemplates.id, templateId))
    .returning({ id: recurringTemplates.id });
  return result.length > 0;
}

// --- Listing --------------------------------------------------------------

export async function listRecurring(
  tx: Database,
  filter: { kind?: 'invoice' | 'bill' | undefined; activeOnly?: boolean | undefined },
) {
  const rows = await tx
    .select()
    .from(recurringTemplates)
    .where(
      and(
        filter.kind ? eq(recurringTemplates.kind, filter.kind) : undefined,
        filter.activeOnly === true ? eq(recurringTemplates.isActive, true) : undefined,
      ),
    )
    .orderBy(asc(recurringTemplates.nextRunDate), desc(recurringTemplates.createdAt));
  return rows;
}

export async function getRecurring(tx: Database, templateId: string) {
  const [row] = await tx
    .select()
    .from(recurringTemplates)
    .where(eq(recurringTemplates.id, templateId));
  return row ?? null;
}

// --- Firing ---------------------------------------------------------------

interface FireResult {
  templateId: string;
  documentId: string;
  documentKind: 'invoice' | 'bill';
  documentNumber: string;
  documentDate: string;
}

/**
 * Fire one occurrence of a template. Uses the template's nextRunDate as the
 * document date by default (so a "Run all due" sweep produces correctly-
 * dated docs even when the user runs it a few days late).
 */
export async function runRecurring(
  tx: Database,
  ctx: RecurringContext,
  templateId: string,
  opts: { documentDate?: string | undefined } = {},
): Promise<FireResult> {
  const [template] = await tx
    .select()
    .from(recurringTemplates)
    .where(eq(recurringTemplates.id, templateId));
  if (!template) throw new RecurringError(`template ${templateId} not found`, 'not_found');
  if (!template.isActive) {
    throw new RecurringError('template is inactive; activate it before running', 'inactive');
  }
  if (template.endDate) {
    const today = todayIso();
    if (parseIsoDate(today).getTime() > parseIsoDate(template.endDate).getTime()) {
      throw new RecurringError(
        `template's end date (${template.endDate}) has already passed`,
        'past_end_date',
      );
    }
  }

  const documentDate = opts.documentDate ?? template.nextRunDate;
  const newRunCount = template.runCount + 1;
  const number = generateRecurringNumber({
    prefix: (template.payload['numberPrefix'] as string | undefined) ?? undefined,
    date: documentDate,
    runCount: newRunCount,
    templateId: template.id,
  });

  let documentId: string;
  if (template.kind === 'invoice') {
    const payload = template.payload as {
      customerId: string;
      termsDays?: number;
      memo?: string;
      taxRateId?: string;
      lines: Array<{
        accountId: string;
        description: string;
        quantity: string | number;
        unitPrice: string | number;
        taxable?: boolean;
      }>;
    };
    try {
      const result = await createInvoice(tx, ctx, {
        customerId: payload.customerId,
        invoiceNumber: number,
        invoiceDate: documentDate,
        ...(payload.memo ? { memo: payload.memo } : {}),
        ...(payload.taxRateId ? { taxRateId: payload.taxRateId } : {}),
        lines: payload.lines.map((l) => ({
          accountId: l.accountId,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxable: l.taxable ?? false,
        })),
      });
      documentId = result.id;
    } catch (err) {
      if (err instanceof InvoiceError) {
        throw new RecurringError(
          `invoice creation failed: ${err.message} [${err.code}]`,
          'invoice_failed',
        );
      }
      throw err;
    }
  } else {
    const payload = template.payload as {
      vendorId: string;
      termsDays?: number;
      memo?: string;
      lines: Array<{
        accountId: string;
        description: string;
        quantity: string | number;
        unitPrice: string | number;
      }>;
    };
    try {
      const result = await createBill(tx, ctx, {
        vendorId: payload.vendorId,
        billNumber: number,
        billDate: documentDate,
        ...(payload.memo ? { memo: payload.memo } : {}),
        lines: payload.lines.map((l) => ({
          accountId: l.accountId,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
        })),
      });
      documentId = result.id;
    } catch (err) {
      if (err instanceof BillError) {
        throw new RecurringError(
          `bill creation failed: ${err.message} [${err.code}]`,
          'bill_failed',
        );
      }
      throw err;
    }
  }

  const sched = scheduleFromInput({
    frequency: template.frequency,
    startDate: template.startDate,
    dayOfMonth: template.dayOfMonth,
    dayOfWeek: template.dayOfWeek,
  });
  const computedNext = nextRunDate(sched, documentDate);

  await tx
    .update(recurringTemplates)
    .set({
      lastRunDate: documentDate,
      lastRunDocumentId: documentId,
      runCount: newRunCount,
      nextRunDate: computedNext,
    })
    .where(eq(recurringTemplates.id, templateId));

  return {
    templateId,
    documentId,
    documentKind: template.kind,
    documentNumber: number,
    documentDate,
  };
}

/**
 * Run every active template whose next_run_date is <= today and whose end_date
 * (if set) hasn't passed. Each template fires at most ONCE per call -- if a
 * template is, say, three months overdue, calling run-all-due three times
 * catches it up. This avoids accidentally posting nine months of rent in one
 * click.
 */
export async function runAllDue(
  tx: Database,
  ctx: RecurringContext,
  asOf?: string,
): Promise<{
  ran: FireResult[];
  failed: Array<{ templateId: string; name: string; error: string; code: string }>;
}> {
  const today = asOf ?? todayIso();

  const due = await tx
    .select()
    .from(recurringTemplates)
    .where(
      and(
        eq(recurringTemplates.isActive, true),
        lte(recurringTemplates.nextRunDate, today),
        // endDate IS NULL (open-ended) OR endDate >= today. The previous
        // eq(endDate, endDate) "dummy true" was NULL in SQL for NULL
        // end_dates, silently excluding every open-ended template.
        or(
          isNull(recurringTemplates.endDate),
          gte(recurringTemplates.endDate, today),
        ),
      ),
    )
    .orderBy(asc(recurringTemplates.nextRunDate));

  // Post-filter end-dates: keep templates with endDate IS NULL OR endDate >= today
  const eligible = due.filter(
    (t) => !t.endDate || parseIsoDate(t.endDate).getTime() >= parseIsoDate(today).getTime(),
  );

  const ran: FireResult[] = [];
  const failed: Array<{ templateId: string; name: string; error: string; code: string }> = [];
  for (const t of eligible) {
    try {
      const result = await runRecurring(tx, ctx, t.id);
      ran.push(result);
    } catch (err) {
      const code = err instanceof RecurringError ? err.code : 'invalid_input';
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ templateId: t.id, name: t.name, error: message, code });
    }
  }
  return { ran, failed };
}
