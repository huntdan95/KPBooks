import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createCompanyForUser } from '../modules/companies/companies.service.js';

const CreateCompanyBody = z.object({
  name: z.string().min(1).max(120),
  legalName: z.string().max(160).optional(),
  ein: z.string().max(20).optional(),
});

/**
 * POST /v1/companies — create a new company and seed default COA.
 *
 * The caller becomes the `owner` of the new company. No x-kpbooks-company
 * header required (the new id is generated server-side and used for RLS
 * inside the transaction).
 */
export const companiesRoutes: FastifyPluginAsync = async (app) => {
  app.post('/companies', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const body = CreateCompanyBody.parse(req.body);

    const result = await createCompanyForUser(app.db, auth.userId, body);
    return reply.status(201).send(result);
  });
};
