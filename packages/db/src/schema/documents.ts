import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { companies, users } from './companies';

/**
 * Custom Drizzle type wrapping Postgres `bytea`. Matches the pattern in
 * worker_documents.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * documents
 *
 * General document repository for everything alongside the books: tax
 * returns, archived 1099s, W-2s, 941s, expense receipts, bank statements,
 * service contracts, correspondence, financial-report exports.
 *
 * Distinct from worker_documents -- that stays scoped to per-vendor HR docs
 * (W-9 / W-4 / I-9 / contracts / insurance / WC). This table is the
 * general-purpose store; rows can OPTIONALLY link back to any other entity
 * via the (related_entity_type, related_entity_id) pair, but it isn't a
 * foreign key (different docs link to different tables).
 *
 * Storage: file_data bytea inline, capped at 10 MiB. If we outgrow inline
 * storage, swap file_data for a Cloud Storage object_path without touching
 * the client side -- downloads stream through the API.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** See documents_category_chk for valid values. */
    category: text('category').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    fileData: bytea('file_data').notNull(),
    /** SHA-256 of the raw bytes; useful for dedup-detection in the UI. */
    sha256: text('sha256').notNull(),
    description: text('description'),
    /** Free-form tags. Empty array means none. */
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** For tax-return-style docs; UI exposes a year picker. */
    taxYear: smallint('tax_year'),
    /** Optional pointer to any other row, e.g. ('vendor', vendor_id). */
    relatedEntityType: text('related_entity_type'),
    relatedEntityId: uuid('related_entity_id'),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete: rows stay for audit but are hidden from the default list. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    companyCategoryCreatedIdx: index('documents_company_category_created_idx').on(
      t.companyId,
      t.category,
      t.createdAt,
    ),
    filenameNonempty: check(
      'documents_filename_nonempty',
      sql`length(${t.filename}) > 0`,
    ),
    sizeChk: check(
      'documents_size_chk',
      sql`${t.fileSizeBytes} > 0 AND ${t.fileSizeBytes} <= 10485760`,
    ),
    categoryChk: check(
      'documents_category_chk',
      sql`${t.category} IN ('tax_return','w9','w2','form_1099','form_941','receipt','statement','contract','correspondence','financial_report','other')`,
    ),
    taxYearRange: check(
      'documents_tax_year_range',
      sql`${t.taxYear} IS NULL OR (${t.taxYear} >= 1990 AND ${t.taxYear} <= 2100)`,
    ),
    relatedPair: check(
      'documents_related_pair',
      sql`(${t.relatedEntityType} IS NULL) = (${t.relatedEntityId} IS NULL)`,
    ),
  }),
);

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocumentRow = typeof documents.$inferInsert;

export type DocumentCategory =
  | 'tax_return'
  | 'w9'
  | 'w2'
  | 'form_1099'
  | 'form_941'
  | 'receipt'
  | 'statement'
  | 'contract'
  | 'correspondence'
  | 'financial_report'
  | 'other';
