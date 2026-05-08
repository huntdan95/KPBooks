import {
  type Database,
  accounts,
  bills,
  payments,
  vendors,
  workerDocuments,
} from '@kpbooks/db';
import { and, asc, desc, eq, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';

/**
 * workers.service - Workers / contractors / employees module.
 *
 * Workers ARE vendors in the data model. The Workers tab is just a focused
 * view of vendors WHERE worker_type IN ('contractor','employee'), with a few
 * extra fields (hire date, pay rate, etc.) and an HR-style document store
 * for W-9 / W-4 / I-9 / contracts. The 1099 prep report continues to pull
 * from the same vendors using the existing is_1099_vendor flag, so a
 * contractor flagged here automatically appears in 1099 prep at year-end
 * when paid >=$600.
 *
 * Why store files inline in Postgres rather than Cloud Storage? Simplicity:
 * one auth/RLS path, one backup, no IAM permissions to coordinate, no signed
 * URLs to manage. For a 250-client practice with ~20 workers each at ~500 KB
 * per doc the total fits comfortably in the same Neon DB.
 */

export const DOCUMENT_TYPES = [
  'w9',
  'w4',
  'i9',
  'contract',
  'insurance',
  'workers_comp',
  'direct_deposit_auth',
  'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const WORKER_TYPES = ['contractor', 'employee', 'not_a_worker'] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

export const PAY_RATE_BASES = [
  'hourly',
  'weekly',
  'biweekly',
  'monthly',
  'annually',
  'project',
] as const;

const Address = z
  .object({
    street1: z.string().max(200).optional(),
    street2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(60).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().max(60).optional(),
  })
  .strict()
  .partial();

/** Used both to add a brand-new worker (creates a vendor row) and for "promote
 *  this existing vendor to a worker". */
export const CreateWorkerSchema = z
  .object({
    /** If set, treat as upgrading an existing vendor; otherwise create new. */
    existingVendorId: z.string().uuid().optional(),
    displayName: z.string().min(1).max(200).optional(),
    companyName: z.string().max(200).optional(),
    title: z.string().max(120).optional(),
    workerType: z.enum(['contractor', 'employee']),
    is1099Vendor: z.boolean().optional(),
    taxId: z.string().max(40).optional(),
    email: z.string().email().max(200).optional(),
    phone: z.string().max(40).optional(),
    mailingAddress: Address.optional(),
    hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    payRate: z.union([z.string(), z.number()]).optional(),
    payRateBasis: z.enum(PAY_RATE_BASES).optional(),
    defaultExpenseAccountId: z.string().uuid().optional(),
    workersCompClass: z.string().max(60).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export type CreateWorkerInput = z.infer<typeof CreateWorkerSchema>;

export const UpdateWorkerSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    companyName: z.string().max(200).nullable().optional(),
    title: z.string().max(120).nullable().optional(),
    workerType: z.enum(WORKER_TYPES).optional(),
    is1099Vendor: z.boolean().optional(),
    taxId: z.string().max(40).nullable().optional(),
    email: z.string().email().max(200).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    mailingAddress: Address.nullable().optional(),
    hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    terminationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    payRate: z.union([z.string(), z.number()]).nullable().optional(),
    payRateBasis: z.enum(PAY_RATE_BASES).nullable().optional(),
    defaultExpenseAccountId: z.string().uuid().nullable().optional(),
    workersCompClass: z.string().max(60).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type UpdateWorkerInput = z.infer<typeof UpdateWorkerSchema>;

export const UploadDocumentSchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES),
    fileName: z.string().min(1).max(260),
    mimeType: z.string().min(1).max(120),
    /** Base64-encoded body (no data: URL prefix). */
    fileBase64: z.string().min(1).max(15 * 1024 * 1024),
    notes: z.string().max(500).optional(),
  })
  .strict();

export type UploadDocumentInput = z.infer<typeof UploadDocumentSchema>;

export class WorkerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'invalid_input'
      | 'duplicate_vendor'
      | 'tax_id_required'
      | 'file_too_large',
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface WorkerContext {
  companyId: string;
  userId: string;
}

/**
 * Promote a worker, creating either a brand-new vendor or upgrading an
 * existing vendor's worker_type. Auto-flips is_1099_vendor=true for
 * contractors unless explicitly set otherwise.
 */
export async function createWorker(
  tx: Database,
  ctx: WorkerContext,
  input: CreateWorkerInput,
): Promise<{ vendorId: string }> {
  const data = CreateWorkerSchema.parse(input);

  // Default 1099 flag: contractors -> true, employees -> false.
  const is1099 = data.is1099Vendor ?? data.workerType === 'contractor';
  if (is1099 && (!data.taxId || data.taxId.trim().length === 0)) {
    throw new WorkerError(
      '1099 contractors require a tax ID (SSN/EIN)',
      'tax_id_required',
    );
  }

  if (data.existingVendorId) {
    const [existing] = await tx
      .select()
      .from(vendors)
      .where(eq(vendors.id, data.existingVendorId));
    if (!existing) {
      throw new WorkerError(`vendor ${data.existingVendorId} not found`, 'not_found');
    }
    const update: Record<string, unknown> = {
      workerType: data.workerType,
      is1099Vendor: is1099,
    };
    if (data.title !== undefined) update.title = data.title;
    if (data.taxId !== undefined) update.taxId = data.taxId;
    if (data.hireDate !== undefined) update.hireDate = data.hireDate;
    if (data.payRate !== undefined) {
      update.payRate = typeof data.payRate === 'number' ? data.payRate.toString() : data.payRate;
    }
    if (data.payRateBasis !== undefined) update.payRateBasis = data.payRateBasis;
    if (data.defaultExpenseAccountId !== undefined)
      update.defaultExpenseAccountId = data.defaultExpenseAccountId;
    if (data.workersCompClass !== undefined) update.workersCompClass = data.workersCompClass;
    if (data.email !== undefined) update.email = data.email;
    if (data.phone !== undefined) update.phone = data.phone;
    if (data.mailingAddress !== undefined) update.mailingAddress = data.mailingAddress;
    if (data.notes !== undefined) update.notes = data.notes;
    update.updatedAt = new Date();
    await tx.update(vendors).set(update).where(eq(vendors.id, data.existingVendorId));
    return { vendorId: data.existingVendorId };
  }

  if (!data.displayName) {
    throw new WorkerError('displayName is required when creating a new worker', 'invalid_input');
  }

  const insertValues: typeof vendors.$inferInsert = {
    companyId: ctx.companyId,
    displayName: data.displayName,
    workerType: data.workerType,
    is1099Vendor: is1099,
    ...(data.companyName ? { companyName: data.companyName } : {}),
    ...(data.title ? { title: data.title } : {}),
    ...(data.taxId ? { taxId: data.taxId } : {}),
    ...(data.email ? { email: data.email } : {}),
    ...(data.phone ? { phone: data.phone } : {}),
    ...(data.mailingAddress ? { mailingAddress: data.mailingAddress } : {}),
    ...(data.hireDate ? { hireDate: data.hireDate } : {}),
    ...(data.payRate !== undefined
      ? { payRate: typeof data.payRate === 'number' ? data.payRate.toString() : data.payRate }
      : {}),
    ...(data.payRateBasis ? { payRateBasis: data.payRateBasis } : {}),
    ...(data.defaultExpenseAccountId
      ? { defaultExpenseAccountId: data.defaultExpenseAccountId }
      : {}),
    ...(data.workersCompClass ? { workersCompClass: data.workersCompClass } : {}),
    ...(data.notes ? { notes: data.notes } : {}),
  };

  const [created] = await tx.insert(vendors).values(insertValues).returning({ id: vendors.id });
  if (!created) {
    throw new WorkerError('failed to create worker', 'invalid_input');
  }
  return { vendorId: created.id };
}

export async function updateWorker(
  tx: Database,
  vendorId: string,
  input: UpdateWorkerInput,
): Promise<void> {
  const data = UpdateWorkerSchema.parse(input);

  const [existing] = await tx.select().from(vendors).where(eq(vendors.id, vendorId));
  if (!existing) throw new WorkerError(`worker ${vendorId} not found`, 'not_found');

  // Tax-ID guard if 1099 stays set.
  const finalIs1099 = data.is1099Vendor ?? existing.is1099Vendor;
  const finalTaxId = data.taxId !== undefined ? data.taxId : existing.taxId;
  if (finalIs1099 && (!finalTaxId || finalTaxId.length === 0)) {
    throw new WorkerError(
      '1099 contractors require a tax ID (SSN/EIN)',
      'tax_id_required',
    );
  }

  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (k === 'payRate' && typeof v === 'number') {
      update[k] = v.toString();
    } else {
      update[k] = v;
    }
  }
  if (Object.keys(update).length === 1) return; // only updatedAt
  await tx.update(vendors).set(update).where(eq(vendors.id, vendorId));
}

/**
 * List of all workers (contractor + employee) with high-level stats:
 * lifetime payments, current-year (1099-relevant) payments, and a flag for
 * whether a W-9 has been uploaded.
 */
export async function listWorkers(
  tx: Database,
  filter: { workerType?: WorkerType | undefined; activeOnly?: boolean | undefined; year?: number | undefined },
): Promise<
  Array<{
    id: string;
    displayName: string;
    companyName: string | null;
    title: string | null;
    workerType: WorkerType;
    is1099Vendor: boolean;
    taxId: string | null;
    email: string | null;
    phone: string | null;
    hireDate: string | null;
    terminationDate: string | null;
    payRate: string | null;
    payRateBasis: string | null;
    isActive: boolean;
    lifetimePaid: string;
    yearPaid: string;
    hasW9: boolean;
    documentCount: number;
  }>
> {
  const year = filter.year ?? new Date().getUTCFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const rows = await tx.execute(sql`
    SELECT
      v.id,
      v.display_name,
      v.company_name,
      v.title,
      v.worker_type,
      v.is_1099_vendor,
      v.tax_id,
      v.email,
      v.phone,
      v.hire_date,
      v.termination_date,
      v.pay_rate,
      v.pay_rate_basis,
      v.is_active,
      COALESCE(SUM(CASE WHEN p.status = 'posted' THEN p.amount ELSE 0 END), 0) AS lifetime_paid,
      COALESCE(
        SUM(CASE
              WHEN p.status = 'posted'
                AND p.payment_date BETWEEN ${yearStart}::date AND ${yearEnd}::date
              THEN p.amount ELSE 0 END),
        0
      ) AS year_paid,
      (SELECT COUNT(*) FROM worker_documents wd WHERE wd.vendor_id = v.id) AS document_count,
      EXISTS (
        SELECT 1 FROM worker_documents wd
         WHERE wd.vendor_id = v.id AND wd.document_type = 'w9'
      ) AS has_w9
    FROM vendors v
    LEFT JOIN payments p
           ON p.vendor_id = v.id
          AND p.payment_type = 'vendor_sent'
    WHERE v.worker_type <> 'not_a_worker'
      ${filter.workerType ? sql`AND v.worker_type = ${filter.workerType}` : sql``}
      ${filter.activeOnly ? sql`AND v.is_active = true` : sql``}
    GROUP BY v.id, v.display_name, v.company_name, v.title, v.worker_type,
             v.is_1099_vendor, v.tax_id, v.email, v.phone, v.hire_date,
             v.termination_date, v.pay_rate, v.pay_rate_basis, v.is_active
    ORDER BY v.is_active DESC, v.display_name ASC
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    displayName: String(r.display_name),
    companyName: r.company_name ? String(r.company_name) : null,
    title: r.title ? String(r.title) : null,
    workerType: r.worker_type as WorkerType,
    is1099Vendor: Boolean(r.is_1099_vendor),
    taxId: r.tax_id ? String(r.tax_id) : null,
    email: r.email ? String(r.email) : null,
    phone: r.phone ? String(r.phone) : null,
    hireDate: r.hire_date ? String(r.hire_date) : null,
    terminationDate: r.termination_date ? String(r.termination_date) : null,
    payRate: r.pay_rate ? String(r.pay_rate) : null,
    payRateBasis: r.pay_rate_basis ? String(r.pay_rate_basis) : null,
    isActive: Boolean(r.is_active),
    lifetimePaid: String(r.lifetime_paid ?? '0'),
    yearPaid: String(r.year_paid ?? '0'),
    hasW9: Boolean(r.has_w9),
    documentCount: Number(r.document_count ?? 0),
  }));
}

/**
 * Detail view: full vendor record + recent payments + recent bills + document
 * list (metadata only; file_data is excluded -- callers fetch it separately
 * via downloadDocument).
 */
export async function getWorker(tx: Database, vendorId: string, year: number) {
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, vendorId));
  if (!vendor) return null;

  const expenseAccount =
    vendor.defaultExpenseAccountId === null
      ? null
      : await tx
          .select({ id: accounts.id, code: accounts.code, name: accounts.name })
          .from(accounts)
          .where(eq(accounts.id, vendor.defaultExpenseAccountId))
          .then((r) => r[0] ?? null);

  const documents = await tx
    .select({
      id: workerDocuments.id,
      documentType: workerDocuments.documentType,
      fileName: workerDocuments.fileName,
      mimeType: workerDocuments.mimeType,
      fileSizeBytes: workerDocuments.fileSizeBytes,
      uploadedByUserId: workerDocuments.uploadedByUserId,
      notes: workerDocuments.notes,
      createdAt: workerDocuments.createdAt,
    })
    .from(workerDocuments)
    .where(eq(workerDocuments.vendorId, vendorId))
    .orderBy(desc(workerDocuments.createdAt));

  const recentPayments = await tx
    .select({
      id: payments.id,
      reference: payments.reference,
      paymentDate: payments.paymentDate,
      amount: payments.amount,
      paymentMethod: payments.paymentMethod,
      status: payments.status,
      memo: payments.memo,
    })
    .from(payments)
    .where(
      and(
        eq(payments.vendorId, vendorId),
        eq(payments.paymentType, 'vendor_sent'),
        ne(payments.status, 'void'),
      ),
    )
    .orderBy(desc(payments.paymentDate), desc(payments.createdAt))
    .limit(50);

  const openBills = await tx
    .select({
      id: bills.id,
      billNumber: bills.billNumber,
      billDate: bills.billDate,
      dueDate: bills.dueDate,
      status: bills.status,
      total: bills.total,
      balanceDue: bills.balanceDue,
    })
    .from(bills)
    .where(and(eq(bills.vendorId, vendorId), or(eq(bills.status, 'open'), eq(bills.status, 'partial'))))
    .orderBy(asc(bills.dueDate))
    .limit(50);

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const [yearTotalRow] = await tx.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN p.status = 'posted' THEN p.amount ELSE 0 END), 0) AS year_paid,
      COUNT(*) FILTER (WHERE p.status = 'posted') AS year_count
    FROM payments p
    WHERE p.vendor_id = ${vendorId}
      AND p.payment_type = 'vendor_sent'
      AND p.payment_date BETWEEN ${yearStart}::date AND ${yearEnd}::date
  `) as unknown as Array<{ year_paid: string; year_count: number }>;

  return {
    ...vendor,
    defaultExpenseAccount: expenseAccount,
    documents,
    recentPayments,
    openBills,
    yearTotalPaid: yearTotalRow?.year_paid ?? '0',
    yearPaymentCount: Number(yearTotalRow?.year_count ?? 0),
    year,
  };
}

export async function uploadDocument(
  tx: Database,
  ctx: WorkerContext,
  vendorId: string,
  input: UploadDocumentInput,
): Promise<{ id: string }> {
  const data = UploadDocumentSchema.parse(input);

  const [vendor] = await tx
    .select({ id: vendors.id })
    .from(vendors)
    .where(eq(vendors.id, vendorId));
  if (!vendor) throw new WorkerError(`worker ${vendorId} not found`, 'not_found');

  const buf = Buffer.from(data.fileBase64, 'base64');
  if (buf.length === 0) {
    throw new WorkerError('empty file', 'invalid_input');
  }
  if (buf.length > MAX_FILE_BYTES) {
    throw new WorkerError(`file too large (max 10 MB, got ${buf.length} bytes)`, 'file_too_large');
  }

  const [created] = await tx
    .insert(workerDocuments)
    .values({
      companyId: ctx.companyId,
      vendorId,
      documentType: data.documentType,
      fileName: data.fileName,
      mimeType: data.mimeType,
      fileSizeBytes: buf.length,
      fileData: buf,
      uploadedByUserId: ctx.userId,
      ...(data.notes ? { notes: data.notes } : {}),
    })
    .returning({ id: workerDocuments.id });
  if (!created) throw new WorkerError('failed to upload document', 'invalid_input');
  return { id: created.id };
}

export async function downloadDocument(
  tx: Database,
  documentId: string,
): Promise<{ fileName: string; mimeType: string; data: Buffer } | null> {
  const [row] = await tx
    .select({
      fileName: workerDocuments.fileName,
      mimeType: workerDocuments.mimeType,
      fileData: workerDocuments.fileData,
    })
    .from(workerDocuments)
    .where(eq(workerDocuments.id, documentId));
  if (!row) return null;
  return { fileName: row.fileName, mimeType: row.mimeType, data: row.fileData };
}

export async function deleteDocument(tx: Database, documentId: string): Promise<boolean> {
  const result = await tx
    .delete(workerDocuments)
    .where(eq(workerDocuments.id, documentId))
    .returning({ id: workerDocuments.id });
  return result.length > 0;
}
