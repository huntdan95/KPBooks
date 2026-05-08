import { type Database, companies, vendors, w9UploadTokens, workerDocuments } from '@kpbooks/db';
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * w9-tokens.service -- generate and consume tokenized W-9 upload links.
 *
 * Two distinct usage modes:
 *
 *   AUTHED (the bookkeeper is logged into the app)
 *     - createW9Token(vendorId)              one-off
 *     - createBulkW9Tokens(year)             everyone over $600 with no W-9
 *
 *   PUBLIC (the contractor opens the URL with no account)
 *     - lookupTokenForPublicView(token)      reads name + company name
 *     - uploadViaToken(token, file)          inserts worker_document, marks token used
 *
 * The public side bypasses RLS for the initial token lookup via a SECURITY
 * DEFINER SQL function (lookup_w9_token from migration 0026), then sets the
 * tenant GUC to the token's company_id and proceeds with normal RLS-aware
 * queries. This keeps RLS strict on every other path.
 */

const TOKEN_TTL_DAYS = 30;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export class W9TokenError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'expired'
      | 'already_used'
      | 'invalid_input'
      | 'no_eligible_email'
      | 'file_too_large',
  ) {
    super(message);
    this.name = 'W9TokenError';
  }
}

export const UploadViaTokenSchema = z
  .object({
    fileName: z.string().min(1).max(260),
    mimeType: z.string().min(1).max(120),
    /** Base64-encoded body (no data: URL prefix). */
    fileBase64: z.string().min(1).max(15 * 1024 * 1024),
    notes: z.string().max(500).optional(),
  })
  .strict();

export type UploadViaTokenInput = z.infer<typeof UploadViaTokenSchema>;

function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

function ttlExpiresAt(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + TOKEN_TTL_DAYS);
  return d;
}

// --- Authed (bookkeeper) side ---------------------------------------------

export interface W9TokenContext {
  companyId: string;
  userId: string;
}

export interface CreatedToken {
  id: string;
  token: string;
  expiresAt: string;
  vendorId: string;
  vendorName: string;
  emailTo: string | null;
  /** Whether we returned an EXISTING unexpired/unused token rather than minting a new one. */
  reused: boolean;
}

/**
 * Create (or reuse) a token for one vendor. If the vendor already has an
 * active (unused, unexpired) token we return that one rather than churning
 * a new URL — keeps the contractor experience stable if the bookkeeper
 * clicks "Send W-9 request" twice.
 */
export async function createW9Token(
  tx: Database,
  ctx: W9TokenContext,
  vendorId: string,
): Promise<CreatedToken> {
  const [vendor] = await tx
    .select({ id: vendors.id, displayName: vendors.displayName, email: vendors.email })
    .from(vendors)
    .where(eq(vendors.id, vendorId));
  if (!vendor) throw new W9TokenError(`vendor ${vendorId} not found`, 'not_found');

  const now = new Date();
  const existingActive = await tx
    .select()
    .from(w9UploadTokens)
    .where(eq(w9UploadTokens.vendorId, vendorId));
  const reusable = existingActive.find(
    (t) => t.usedAt === null && t.expiresAt > now,
  );
  if (reusable) {
    return {
      id: reusable.id,
      token: reusable.token,
      expiresAt: reusable.expiresAt.toISOString(),
      vendorId,
      vendorName: vendor.displayName,
      emailTo: reusable.emailTo,
      reused: true,
    };
  }

  const token = generateRawToken();
  const expiresAt = ttlExpiresAt();
  const [created] = await tx
    .insert(w9UploadTokens)
    .values({
      companyId: ctx.companyId,
      vendorId,
      token,
      expiresAt,
      ...(vendor.email ? { emailTo: vendor.email } : {}),
      ...(ctx.userId ? { createdByUserId: ctx.userId } : {}),
    })
    .returning({ id: w9UploadTokens.id });
  if (!created) throw new W9TokenError('failed to create token', 'invalid_input');

  return {
    id: created.id,
    token,
    expiresAt: expiresAt.toISOString(),
    vendorId,
    vendorName: vendor.displayName,
    emailTo: vendor.email,
    reused: false,
  };
}

export interface BulkEligibleVendor {
  vendorId: string;
  displayName: string;
  email: string | null;
  taxId: string | null;
  yearTotal: string;
  hasW9: boolean;
  hasActiveToken: boolean;
}

/**
 * List 1099 contractors who would benefit from a W-9 reminder for the given
 * tax year: paid >= $600 in non-employee comp and no W-9 on file.
 *
 * Used by the bulk panel on the 1099 Prep page to preview targets before
 * minting tokens en masse.
 */
export async function listBulkEligible(
  tx: Database,
  year: number,
): Promise<BulkEligibleVendor[]> {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const rows = await tx.execute(sql`
    SELECT
      v.id,
      v.display_name,
      v.email,
      v.tax_id,
      COALESCE(
        SUM(CASE WHEN p.status = 'posted' THEN p.amount ELSE 0 END),
        0
      ) AS year_total,
      EXISTS (
        SELECT 1 FROM worker_documents wd
         WHERE wd.vendor_id = v.id AND wd.document_type = 'w9'
      ) AS has_w9,
      EXISTS (
        SELECT 1 FROM w9_upload_tokens t
         WHERE t.vendor_id = v.id AND t.used_at IS NULL AND t.expires_at > now()
      ) AS has_active_token
    FROM vendors v
    LEFT JOIN payments p
           ON p.vendor_id = v.id
          AND p.payment_type = 'vendor_sent'
          AND p.payment_date BETWEEN ${yearStart}::date AND ${yearEnd}::date
    WHERE v.is_1099_vendor = true
      AND v.is_active = true
    GROUP BY v.id, v.display_name, v.email, v.tax_id
    HAVING COALESCE(SUM(CASE WHEN p.status = 'posted' THEN p.amount ELSE 0 END), 0) >= 600
       AND NOT EXISTS (
         SELECT 1 FROM worker_documents wd
          WHERE wd.vendor_id = v.id AND wd.document_type = 'w9'
       )
    ORDER BY year_total DESC, v.display_name
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    vendorId: String(r.id),
    displayName: String(r.display_name),
    email: r.email ? String(r.email) : null,
    taxId: r.tax_id ? String(r.tax_id) : null,
    yearTotal: String(r.year_total ?? '0'),
    hasW9: Boolean(r.has_w9),
    hasActiveToken: Boolean(r.has_active_token),
  }));
}

export async function createBulkW9Tokens(
  tx: Database,
  ctx: W9TokenContext,
  year: number,
  vendorIdsFilter?: string[],
): Promise<CreatedToken[]> {
  const eligible = await listBulkEligible(tx, year);
  const targets =
    vendorIdsFilter && vendorIdsFilter.length > 0
      ? eligible.filter((e) => vendorIdsFilter.includes(e.vendorId))
      : eligible;
  const results: CreatedToken[] = [];
  for (const t of targets) {
    results.push(await createW9Token(tx, ctx, t.vendorId));
  }
  return results;
}

// --- Public (no-auth) side ------------------------------------------------

export interface PublicTokenInfo {
  /** Whether the token is valid + not yet used + not expired. */
  valid: boolean;
  /** Surfaced friendly reason (only present when valid=false). */
  reason: 'not_found' | 'expired' | 'already_used' | null;
  vendorName: string | null;
  companyName: string | null;
  /** Empty when the token is invalid; populated otherwise. */
  expiresAt: string | null;
}

/**
 * Used by the public (no-auth) /v1/w9-upload/:token/info route.
 *
 * Step 1: SECURITY DEFINER lookup_w9_token(token) -- bypasses RLS to read
 *         the lookup row.
 * Step 2: If valid, set GUC to that company_id and re-read vendor + company
 *         name with normal RLS-aware queries.
 *
 * Never exposes anything sensitive: only the contractor's display_name and
 * the company's name (so the contractor sees who they're submitting to).
 */
export async function lookupTokenForPublicView(
  db: Database,
  token: string,
): Promise<PublicTokenInfo> {
  return db.transaction(async (tx) => {
    const lookupRows = await tx.execute(sql`SELECT * FROM lookup_w9_token(${token})`);
    const lookup = (lookupRows as unknown as Array<{
      token_id: string;
      company_id: string;
      vendor_id: string;
      expires_at: Date | string;
      used_at: Date | string | null;
    }>)[0];
    if (!lookup) {
      return {
        valid: false,
        reason: 'not_found' as const,
        vendorName: null,
        companyName: null,
        expiresAt: null,
      };
    }
    const expiresAt =
      typeof lookup.expires_at === 'string' ? new Date(lookup.expires_at) : lookup.expires_at;
    if (lookup.used_at) {
      return {
        valid: false,
        reason: 'already_used' as const,
        vendorName: null,
        companyName: null,
        expiresAt: expiresAt.toISOString(),
      };
    }
    if (expiresAt.getTime() <= Date.now()) {
      return {
        valid: false,
        reason: 'expired' as const,
        vendorName: null,
        companyName: null,
        expiresAt: expiresAt.toISOString(),
      };
    }

    // Set the tenant GUC to the company we just learned about so the next
    // queries succeed under RLS without needing a service role.
    await tx.execute(
      sql`SELECT set_config('app.current_company', ${lookup.company_id}, true)`,
    );

    const [vendor] = await tx
      .select({ name: vendors.displayName })
      .from(vendors)
      .where(eq(vendors.id, lookup.vendor_id));
    const [company] = await tx
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, lookup.company_id));

    return {
      valid: true,
      reason: null,
      vendorName: vendor?.name ?? null,
      companyName: company?.name ?? null,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

/**
 * The contractor-facing upload. Same security pattern as the lookup:
 * SECURITY DEFINER -> set GUC -> RLS-aware INSERT/UPDATE.
 */
export async function uploadViaToken(
  db: Database,
  token: string,
  input: UploadViaTokenInput,
): Promise<{ documentId: string }> {
  const data = UploadViaTokenSchema.parse(input);

  const buf = Buffer.from(data.fileBase64, 'base64');
  if (buf.length === 0) {
    throw new W9TokenError('empty file', 'invalid_input');
  }
  if (buf.length > MAX_FILE_BYTES) {
    throw new W9TokenError(
      `file too large (max 10 MB, got ${buf.length} bytes)`,
      'file_too_large',
    );
  }

  return db.transaction(async (tx) => {
    const lookupRows = await tx.execute(sql`SELECT * FROM lookup_w9_token(${token})`);
    const lookup = (lookupRows as unknown as Array<{
      token_id: string;
      company_id: string;
      vendor_id: string;
      expires_at: Date | string;
      used_at: Date | string | null;
    }>)[0];
    if (!lookup) throw new W9TokenError('token not found', 'not_found');
    const expiresAt =
      typeof lookup.expires_at === 'string' ? new Date(lookup.expires_at) : lookup.expires_at;
    if (lookup.used_at) {
      throw new W9TokenError('this upload link has already been used', 'already_used');
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw new W9TokenError('this upload link has expired', 'expired');
    }

    await tx.execute(
      sql`SELECT set_config('app.current_company', ${lookup.company_id}, true)`,
    );

    const [doc] = await tx
      .insert(workerDocuments)
      .values({
        companyId: lookup.company_id,
        vendorId: lookup.vendor_id,
        documentType: 'w9',
        fileName: data.fileName,
        mimeType: data.mimeType,
        fileSizeBytes: buf.length,
        fileData: buf,
        ...(data.notes ? { notes: data.notes } : {}),
        // No uploadedByUserId — public upload, no logged-in user.
      })
      .returning({ id: workerDocuments.id });
    if (!doc) throw new W9TokenError('failed to save document', 'invalid_input');

    await tx
      .update(w9UploadTokens)
      .set({ usedAt: new Date(), usedDocumentId: doc.id })
      .where(and(eq(w9UploadTokens.id, lookup.token_id)));

    return { documentId: doc.id };
  });
}
