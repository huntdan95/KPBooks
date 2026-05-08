import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { companies, users } from './companies';
import { vendors } from './vendors';

/**
 * Custom Drizzle type wrapping Postgres `bytea`. The driver returns Buffer on
 * read; we accept Buffer on write. Documents are capped at 10 MiB by a check
 * constraint so a malicious upload can't fill the table.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * worker_documents
 * HR-style document storage attached to a vendor (W-9, W-4, I-9, contracts,
 * insurance certs, workers-comp, direct-deposit auths, misc). Files are
 * stored inline as bytea; for a 250-client practice with ~20 workers each at
 * ~500 KB per doc, total storage stays well under 3 GB which is fine for
 * Postgres. If we outgrow inline storage, swap file_data for a Cloud
 * Storage URL without touching anything else.
 */
export const workerDocuments = pgTable(
  'worker_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    /** w9 / w4 / i9 / contract / insurance / workers_comp / direct_deposit_auth / other. */
    documentType: text('document_type').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    fileData: bytea('file_data').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyVendorIdx: index('worker_documents_company_vendor_idx').on(t.companyId, t.vendorId),
    companyTypeIdx: index('worker_documents_company_type_idx').on(t.companyId, t.documentType),
    documentTypeChk: check(
      'worker_documents_document_type_chk',
      sql`${t.documentType} IN ('w9','w4','i9','contract','insurance','workers_comp','direct_deposit_auth','other')`,
    ),
    sizeChk: check(
      'worker_documents_size_chk',
      sql`${t.fileSizeBytes} > 0 AND ${t.fileSizeBytes} <= 10485760`,
    ),
  }),
);

export type WorkerDocument = typeof workerDocuments.$inferSelect;
export type NewWorkerDocument = typeof workerDocuments.$inferInsert;
