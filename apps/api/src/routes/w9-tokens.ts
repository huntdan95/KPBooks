import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  W9TokenError,
  createBulkW9Tokens,
  createW9Token,
  listBulkEligible,
} from '../modules/w9-tokens/w9-tokens.service.js';

/**
 * Authed routes for the bookkeeper-facing W-9 reminder workflow.
 * Public (no-auth) upload routes live in w9-public.ts.
 */

const errStatus = (code: W9TokenError['code']): number => {
  switch (code) {
    case 'not_found':
      return 404;
    case 'expired':
    case 'already_used':
      return 409;
    case 'file_too_large':
      return 413;
    default:
      return 422;
  }
};

export const w9TokensRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  /** Single-vendor token. Returns existing active token if one exists. */
  app.post('/workers/:id/w9-request', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      const result = await req.withTenantTx(async (tx) =>
        createW9Token(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof W9TokenError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  /** Preview list -- 1099 contractors paid >= $600 in `year` with no W-9 on file. */
  app.get('/w9-bulk/eligible', async (req) => {
    const { year } = z
      .object({ year: z.coerce.number().int().min(2000).max(2100) })
      .parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await listBulkEligible(tx, year);
      return { year, eligible: rows };
    });
  });

  /** Bulk-generate tokens. If `vendorIds` is omitted we generate for ALL eligible. */
  app.post('/w9-bulk/generate', async (req, reply) => {
    const body = z
      .object({
        year: z.number().int().min(2000).max(2100),
        vendorIds: z.array(z.string().uuid()).optional(),
      })
      .strict()
      .parse(req.body);
    try {
      const tokens = await req.withTenantTx(async (tx) =>
        createBulkW9Tokens(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body.year,
          body.vendorIds,
        ),
      );
      return reply.status(201).send({ tokens, count: tokens.length });
    } catch (err) {
      if (err instanceof W9TokenError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
