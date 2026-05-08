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
} from '../modules/imports/iif.js';

const PreviewBody = z.object({
  text: z.string().min(1, 'IIF text is required').max(5_000_000, 'file too large (>5MB)'),
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
    const existingNames = await req.withTenantTx(async (tx) => {
      const rows = await tx.select({ name: accounts.name }).from(accounts);
      return new Set(rows.map((r) => r.name));
    });
    parsed.missingAccounts = buildMissingAccounts(parsed, existingNames);
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
