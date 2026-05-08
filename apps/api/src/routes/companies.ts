import { companies } from '@kpbooks/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createCompanyForUser } from '../modules/companies/companies.service.js';

const CreateCompanyBody = z.object({
  name: z.string().min(1).max(120),
  legalName: z.string().max(160).optional(),
  ein: z.string().max(20).optional(),
});

const UpdateCompanyBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    legalName: z.string().max(160).nullable().optional(),
    ein: z.string().max(20).nullable().optional(),
    /** YYYY-MM-DD or null to clear. */
    closedThroughDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
      .nullable()
      .optional(),
  })
  .strict();

export const companiesRoutes: FastifyPluginAsync = async (app) => {
  app.post('/companies', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const body = CreateCompanyBody.parse(req.body);

    const result = await createCompanyForUser(app.db, auth.userId, body);
    return reply.status(201).send(result);
  });

  /**
   * GET /v1/companies/current — return details of the company in the
   * x-kpbooks-company header. Includes closed_through_date + fiscal start
   * so the UI can render Settings / Period Close screens.
   */
  app.get('/companies/current', async (req, reply) => {
    await app.requireAuth(req);
    return req.withTenantTx(async (tx) => {
      const [row] = await tx
        .select({
          id: companies.id,
          name: companies.name,
          legalName: companies.legalName,
          ein: companies.ein,
          fiscalYearStartMonth: companies.fiscalYearStartMonth,
          baseCurrency: companies.baseCurrency,
          closedThroughDate: companies.closedThroughDate,
          createdAt: companies.createdAt,
          updatedAt: companies.updatedAt,
        })
        .from(companies)
        .where(eq(companies.id, req.auth!.companyId!));
      if (!row) return reply.status(404).send({ error: 'not_found' });
      return row;
    });
  });

  /**
   * PATCH /v1/companies/current — owner/admin only. Used for Settings +
   * Period Close. Closed-through-date is the same column the
   * ledger_enforce_closed_period DB trigger reads at post time.
   */
  app.patch('/companies/current', async (req, reply) => {
    await app.requireAuth(req);
    const role = req.auth!.role;
    if (role !== 'owner' && role !== 'admin') {
      return reply.status(403).send({ error: 'forbidden', message: 'requires owner or admin role' });
    }
    const body = UpdateCompanyBody.parse(req.body);
    return req.withTenantTx(async (tx) => {
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.legalName !== undefined) update.legalName = body.legalName;
      if (body.ein !== undefined) update.ein = body.ein;
      if (body.closedThroughDate !== undefined) update.closedThroughDate = body.closedThroughDate;

      if (Object.keys(update).length === 0) {
        const [row] = await tx
          .select()
          .from(companies)
          .where(eq(companies.id, req.auth!.companyId!));
        if (!row) return reply.status(404).send({ error: 'not_found' });
        return row;
      }

      const [updated] = await tx
        .update(companies)
        .set(update)
        .where(eq(companies.id, req.auth!.companyId!))
        .returning();
      if (!updated) return reply.status(404).send({ error: 'not_found' });
      return updated;
    });
  });
};
