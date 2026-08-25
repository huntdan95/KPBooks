import { accounts } from '@kpbooks/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CommitIifSchema,
  CommitIifTransactionsSchema,
  buildMissingAccounts,
  commitIifImport,
  commitIifTransactions,
  parseIif,
  warnInactiveAccountRefs,
} from '../modules/imports/iif.js';
import {
  parseJournalCsv,
  resolveLeafAccountNames,
} from '../modules/imports/journal-report.js';
import { parseJournalXlsx } from '../modules/imports/journal-xlsx.js';

/**
 * Multi-year QBD transaction exports routinely run 5-12 MB, so the cap sits
 * at 12 MB -- under the Fastify bodyLimit with headroom for JSON escaping and
 * for the commit-transactions leg (parsed JSON is larger than the raw text).
 * Exported for the regression tests in test/iif-gauntlet.test.ts.
 */
export const PreviewBody = z.object({
  text: z
    .string()
    .min(1, 'IIF text is required')
    .max(
      12_000_000,
      'file too large (>12MB) -- export from QuickBooks in date-range chunks and import each ' +
        'one; re-importing overlapping ranges is safe for unchanged transactions (already-' +
        'posted transactions are skipped as duplicates; a transaction edited in QuickBooks ' +
        'since an earlier import posts again, and the commit warns when it detects that)',
    ),
});

/**
 * Journal-report preview accepts either the .xlsx QuickBooks' "Export to
 * Excel" produces (base64, since it is binary) or a .csv the user saved
 * instead. Base64 inflates by ~4/3, hence the larger cap on that field.
 */
export const JournalPreviewBody = z
  .object({
    fileBase64: z.string().min(1).max(16_000_000).optional(),
    text: z.string().min(1).max(12_000_000).optional(),
    dateOrder: z.enum(['mdy', 'dmy']).optional(),
  })
  .refine((b) => Boolean(b.fileBase64 || b.text), {
    message: 'provide either fileBase64 (.xlsx) or text (.csv)',
  });

export const importsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  /**
   * Preview parses the IIF, then queries the company's existing accounts so
   * we can populate `missingAccounts` -- transaction-referenced accounts that
   * neither exist nor are about to be created from the file's own !ACCNT
   * section. The UI surfaces these for the user to review/override before
   * committing.
   */
  app.post('/imports/iif/preview', async (req) => {
    const { text } = PreviewBody.parse(req.body);
    const parsed = parseIif(text);
    const { existingNames, inactiveNames } = await req.withTenantTx(async (tx) => {
      const rows = await tx
        .select({ name: accounts.name, isActive: accounts.isActive })
        .from(accounts);
      return {
        existingNames: new Set(rows.map((r) => r.name)),
        inactiveNames: new Set(rows.filter((r) => !r.isActive).map((r) => r.name)),
      };
    });
    parsed.missingAccounts = buildMissingAccounts(parsed, existingNames);
    // Two-file migrations (lists IIF first, then transactions IIF): the
    // lists import created HIDDEN=Y accounts as inactive, so a transactions
    // file that references them previews clean while every block touching
    // them would die per-row at commit. Disclose it now, while the user can
    // still plan around it.
    warnInactiveAccountRefs(parsed, inactiveNames);
    return parsed;
  });

  /**
   * QuickBooks cannot export transactions to IIF, so a full-history migration
   * comes from the Journal report instead. It parses to the same preview shape
   * as an IIF transactions file, which lets it reuse
   * /imports/iif/commit-transactions unchanged — including the duplicate
   * fingerprinting that makes a re-import safe.
   */
  app.post('/imports/journal/preview', async (req) => {
    const body = JournalPreviewBody.parse(req.body);
    const parsed = body.fileBase64
      ? await parseJournalXlsx(Buffer.from(body.fileBase64, 'base64'), {
          ...(body.dateOrder ? { dateOrder: body.dateOrder } : {}),
        })
      : parseJournalCsv(body.text!, {
          ...(body.dateOrder ? { dateOrder: body.dateOrder } : {}),
        });

    const { existingNames, inactiveNames } = await req.withTenantTx(async (tx) => {
      const rows = await tx
        .select({ name: accounts.name, isActive: accounts.isActive })
        .from(accounts);
      return {
        existingNames: new Set(rows.map((r) => r.name)),
        inactiveNames: new Set(rows.filter((r) => !r.isActive).map((r) => r.name)),
      };
    });

    // Must run BEFORE buildMissingAccounts: the report prints only a
    // sub-account's leaf name, so without this every sub-account would look
    // missing and be offered as a new top-level duplicate.
    resolveLeafAccountNames(parsed, existingNames);
    parsed.missingAccounts = buildMissingAccounts(parsed, existingNames);
    warnInactiveAccountRefs(parsed, inactiveNames);
    return parsed;
  });

  app.post('/imports/iif/commit', async (req, reply) => {
    const body = CommitIifSchema.parse(req.body);
    const result = await req.withTenantTx(async (tx) =>
      commitIifImport(
        tx,
        { companyId: req.auth!.companyId!, userId: req.auth!.userId },
        body,
      ),
    );
    return reply.status(201).send(result);
  });

  app.post('/imports/iif/commit-transactions', async (req, reply) => {
    const body = CommitIifTransactionsSchema.parse(req.body);
    const result = await req.withTenantTx(async (tx) =>
      commitIifTransactions(
        tx,
        { companyId: req.auth!.companyId!, userId: req.auth!.userId },
        body,
      ),
    );
    return reply.status(201).send(result);
  });
};
