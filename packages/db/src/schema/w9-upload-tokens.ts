import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { companies, users } from './companies';
import { vendors } from './vendors';
import { workerDocuments } from './worker-documents';

/**
 * w9_upload_tokens
 *
 * Tokenized links for contractors to upload their W-9 without an account.
 * The bookkeeper generates the token; the contractor opens the URL in a
 * normal browser (no login, no app install) and uploads PDF or photo.
 *
 * Single-use: once an upload happens we set used_at + used_document_id.
 * Time-limited: default 30 days.
 *
 * The public upload route (no auth) reads the token via a SECURITY DEFINER
 * SQL function (see migration 0026) so we don't have to weaken RLS to
 * support the no-auth flow.
 */
export const w9UploadTokens = pgTable(
  'w9_upload_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    /** 32 random bytes, base64url-encoded. ~43 chars, URL-safe. */
    token: text('token').notNull(),
    /** Snapshot of the recipient's email at token-creation time, for the mailto link. */
    emailTo: text('email_to'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedDocumentId: uuid('used_document_id').references(() => workerDocuments.id, {
      onDelete: 'set null',
    }),
  },
  (t) => ({
    tokenIdx: uniqueIndex('w9_upload_tokens_token_idx').on(t.token),
    companyIdx: index('w9_upload_tokens_company_idx').on(t.companyId),
    vendorIdx: index('w9_upload_tokens_vendor_idx').on(t.vendorId),
  }),
);

export type W9UploadToken = typeof w9UploadTokens.$inferSelect;
export type NewW9UploadToken = typeof w9UploadTokens.$inferInsert;
