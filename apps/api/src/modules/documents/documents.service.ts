import { type Database, documents } from '@kpbooks/db';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordActivity } from '../activity/activity.service.js';

/**
 * documents.service -- general document repository.
 *
 * Files arrive base64-encoded in the JSON body (matches the worker_documents
 * pattern; uses the same 16 MiB body limit). Stored inline as bytea, capped
 * at 10 MiB raw per file. Rows soft-delete (deleted_at) so an accidental
 * delete is recoverable; the UI hides deleted by default but can show them
 * with includeDeleted=true.
 *
 * Out of scope (future):
 *   - Cloud-Storage-backed storage for >10 MiB files (requires direct-upload
 *     signed URLs)
 *   - Server-side OCR / full-text search on PDF contents
 *   - Versioning (replace-in-place currently means a fresh row)
 *   - Per-user permissions / share links
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const DOCUMENT_CATEGORIES = [
  'tax_return',
  'w9',
  'w2',
  'form_1099',
  'form_941',
  'receipt',
  'statement',
  'contract',
  'correspondence',
  'financial_report',
  'other',
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export class DocumentError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'invalid_input'
      | 'file_too_large'
      | 'empty_file'
      | 'unsupported_mime'
      | 'wrong_status',
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}

export interface DocumentContext {
  companyId: string;
  userId: string;
}

// -- Schemas ---------------------------------------------------------------

export const UploadDocumentSchema = z
  .object({
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(120),
    fileBase64: z.string().min(1),
    category: z.enum(DOCUMENT_CATEGORIES),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    taxYear: z.number().int().min(1990).max(2100).optional(),
    relatedEntityType: z.string().min(1).max(40).optional(),
    relatedEntityId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (d) =>
      (d.relatedEntityType === undefined && d.relatedEntityId === undefined) ||
      (d.relatedEntityType !== undefined && d.relatedEntityId !== undefined),
    {
      message: 'relatedEntityType and relatedEntityId must be set together',
      path: ['relatedEntityType'],
    },
  );
export type UploadDocumentInput = z.infer<typeof UploadDocumentSchema>;

export const UpdateDocumentSchema = z
  .object({
    category: z.enum(DOCUMENT_CATEGORIES).optional(),
    description: z.string().max(2000).nullable().optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    taxYear: z.number().int().min(1990).max(2100).nullable().optional(),
    relatedEntityType: z.string().min(1).max(40).nullable().optional(),
    relatedEntityId: z.string().uuid().nullable().optional(),
    filename: z.string().min(1).max(255).optional(),
  })
  .strict();
export type UpdateDocumentInput = z.infer<typeof UpdateDocumentSchema>;

export const ListDocumentsQuerySchema = z.object({
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  taxYear: z.coerce.number().int().min(1990).max(2100).optional(),
  q: z.string().min(1).max(200).optional(),
  entityType: z.string().min(1).max(40).optional(),
  entityId: z.string().uuid().optional(),
  includeDeleted: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ListDocumentsQuery = z.infer<typeof ListDocumentsQuerySchema>;

// -- Read -------------------------------------------------------------------

export interface DocumentSummary {
  id: string;
  category: DocumentCategory;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  sha256: string;
  description: string | null;
  tags: string[];
  taxYear: number | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  uploadedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export async function listDocuments(
  tx: Database,
  filter: ListDocumentsQuery,
): Promise<DocumentSummary[]> {
  const conditions = [];
  if (filter.category) conditions.push(eq(documents.category, filter.category));
  if (filter.taxYear !== undefined) conditions.push(eq(documents.taxYear, filter.taxYear));
  if (filter.q) {
    // Filename ILIKE with simple wildcard on both sides. Description ILIKE for
    // a slightly broader hit. Both run against the GIN-eligible expression
    // but at v1 we just rely on the lower(filename) index for prefix matches.
    const pat = `%${filter.q}%`;
    conditions.push(
      sql`(${documents.filename} ILIKE ${pat} OR ${documents.description} ILIKE ${pat})`,
    );
  }
  if (filter.entityType) conditions.push(eq(documents.relatedEntityType, filter.entityType));
  if (filter.entityId) conditions.push(eq(documents.relatedEntityId, filter.entityId));
  if (filter.includeDeleted !== 'true') {
    conditions.push(isNull(documents.deletedAt));
  }

  const rows = await tx
    .select({
      id: documents.id,
      category: documents.category,
      filename: documents.filename,
      mimeType: documents.mimeType,
      fileSizeBytes: documents.fileSizeBytes,
      sha256: documents.sha256,
      description: documents.description,
      tags: documents.tags,
      taxYear: documents.taxYear,
      relatedEntityType: documents.relatedEntityType,
      relatedEntityId: documents.relatedEntityId,
      uploadedByUserId: documents.uploadedByUserId,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(documents.createdAt), asc(documents.id))
    .limit(filter.limit);

  return rows.map((r) => ({
    id: r.id,
    category: r.category as DocumentCategory,
    filename: r.filename,
    mimeType: r.mimeType,
    fileSizeBytes: r.fileSizeBytes,
    sha256: r.sha256,
    description: r.description,
    tags: r.tags ?? [],
    taxYear: r.taxYear,
    relatedEntityType: r.relatedEntityType,
    relatedEntityId: r.relatedEntityId,
    uploadedByUserId: r.uploadedByUserId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  }));
}

export async function getDocument(
  tx: Database,
  id: string,
): Promise<DocumentSummary | null> {
  const rows = await listDocuments(tx, {
    includeDeleted: 'true',
    limit: 1,
  } as ListDocumentsQuery);
  // listDocuments doesn't filter by id; do a direct query instead.
  void rows;
  const [row] = await tx.select().from(documents).where(eq(documents.id, id));
  if (!row) return null;
  return {
    id: row.id,
    category: row.category as DocumentCategory,
    filename: row.filename,
    mimeType: row.mimeType,
    fileSizeBytes: row.fileSizeBytes,
    sha256: row.sha256,
    description: row.description,
    tags: row.tags ?? [],
    taxYear: row.taxYear,
    relatedEntityType: row.relatedEntityType,
    relatedEntityId: row.relatedEntityId,
    uploadedByUserId: row.uploadedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

export async function downloadDocument(
  tx: Database,
  id: string,
): Promise<{ filename: string; mimeType: string; data: Buffer } | null> {
  const [row] = await tx
    .select({
      filename: documents.filename,
      mimeType: documents.mimeType,
      fileData: documents.fileData,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(eq(documents.id, id));
  if (!row || row.deletedAt) return null;
  return { filename: row.filename, mimeType: row.mimeType, data: row.fileData };
}

// -- Write ------------------------------------------------------------------

export async function uploadDocument(
  tx: Database,
  ctx: DocumentContext,
  input: UploadDocumentInput,
): Promise<{ id: string; sha256: string }> {
  const buf = Buffer.from(input.fileBase64, 'base64');
  if (buf.length === 0) {
    throw new DocumentError('empty file', 'empty_file');
  }
  if (buf.length > MAX_FILE_BYTES) {
    throw new DocumentError(
      `file too large (max 10 MiB, got ${buf.length} bytes)`,
      'file_too_large',
    );
  }

  const sha256 = createHash('sha256').update(buf).digest('hex');

  const [created] = await tx
    .insert(documents)
    .values({
      companyId: ctx.companyId,
      category: input.category,
      filename: input.filename,
      mimeType: input.mimeType,
      fileSizeBytes: buf.length,
      fileData: buf,
      sha256,
      description: input.description ?? null,
      tags: input.tags ?? [],
      taxYear: input.taxYear ?? null,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      uploadedByUserId: ctx.userId,
    })
    .returning({ id: documents.id });

  if (!created) throw new DocumentError('failed to insert document', 'invalid_input');

  await recordActivity(
    tx,
    { companyId: ctx.companyId, userId: ctx.userId },
    {
      action: 'uploaded_document',
      entityType: 'document',
      entityId: created.id,
      summary: `Uploaded ${input.category.replace(/_/g, ' ')}: "${input.filename}" (${formatBytes(buf.length)})`,
      details: {
        category: input.category,
        filename: input.filename,
        mimeType: input.mimeType,
        fileSizeBytes: buf.length,
        sha256,
        taxYear: input.taxYear ?? null,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
      },
    },
  );

  return { id: created.id, sha256 };
}

export async function updateDocument(
  tx: Database,
  ctx: DocumentContext,
  id: string,
  input: UpdateDocumentInput,
): Promise<void> {
  const [existing] = await tx
    .select({ id: documents.id, deletedAt: documents.deletedAt })
    .from(documents)
    .where(eq(documents.id, id));
  if (!existing) throw new DocumentError('document not found', 'not_found');
  if (existing.deletedAt) {
    throw new DocumentError('document is deleted', 'wrong_status');
  }

  const update: Record<string, unknown> = {};
  if (input.category !== undefined) update.category = input.category;
  if (input.description !== undefined) update.description = input.description;
  if (input.tags !== undefined) update.tags = input.tags;
  if (input.taxYear !== undefined) update.taxYear = input.taxYear;
  if (input.filename !== undefined) update.filename = input.filename;
  // Related-entity pair: must be set or cleared together. The DB CHECK also
  // enforces this, but we validate up-front for a friendlier error.
  if (input.relatedEntityType !== undefined || input.relatedEntityId !== undefined) {
    const tNull = input.relatedEntityType === null || input.relatedEntityType === undefined;
    const idNull = input.relatedEntityId === null || input.relatedEntityId === undefined;
    if (tNull !== idNull) {
      throw new DocumentError(
        'relatedEntityType and relatedEntityId must be set or cleared together',
        'invalid_input',
      );
    }
    update.relatedEntityType = input.relatedEntityType ?? null;
    update.relatedEntityId = input.relatedEntityId ?? null;
  }

  if (Object.keys(update).length === 0) return;
  update.updatedAt = new Date();
  await tx.update(documents).set(update).where(eq(documents.id, id));

  await recordActivity(
    tx,
    { companyId: ctx.companyId, userId: ctx.userId },
    {
      action: 'updated_document',
      entityType: 'document',
      entityId: id,
      summary: `Updated document metadata`,
      details: { changes: update },
    },
  );
}

export async function deleteDocument(
  tx: Database,
  ctx: DocumentContext,
  id: string,
): Promise<void> {
  const [row] = await tx
    .select({ filename: documents.filename, deletedAt: documents.deletedAt })
    .from(documents)
    .where(eq(documents.id, id));
  if (!row) throw new DocumentError('document not found', 'not_found');
  if (row.deletedAt) return; // already deleted; idempotent

  await tx
    .update(documents)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(documents.id, id));

  await recordActivity(
    tx,
    { companyId: ctx.companyId, userId: ctx.userId },
    {
      action: 'deleted_document',
      entityType: 'document',
      entityId: id,
      summary: `Deleted document "${row.filename}"`,
      details: { filename: row.filename },
    },
  );
}

export async function restoreDocument(
  tx: Database,
  ctx: DocumentContext,
  id: string,
): Promise<void> {
  const [row] = await tx
    .select({ filename: documents.filename, deletedAt: documents.deletedAt })
    .from(documents)
    .where(eq(documents.id, id));
  if (!row) throw new DocumentError('document not found', 'not_found');
  if (!row.deletedAt) return;

  await tx
    .update(documents)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(eq(documents.id, id));

  await recordActivity(
    tx,
    { companyId: ctx.companyId, userId: ctx.userId },
    {
      action: 'restored_document',
      entityType: 'document',
      entityId: id,
      summary: `Restored document "${row.filename}"`,
      details: { filename: row.filename },
    },
  );
}

// -- Bits -------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Silence unused-import warnings if certain shapes aren't used.
void inArray;
void ilike;
