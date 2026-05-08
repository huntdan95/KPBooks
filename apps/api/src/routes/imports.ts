import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CommitIifSchema,
  CommitIifTransactionsSchema,
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

  // Preview is read-only -- no DB write, no tx wrapper. Just parse + return.
  app.post('/imports/iif/preview', async (req) => {
    const { text } = PreviewBody.parse(req.body);
    return parseIif(text);
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
