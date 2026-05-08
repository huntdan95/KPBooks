import { taxRates } from '@kpbooks/db';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const ListQuery = z.object({
  active: z.enum(['true', 'false']).optional(),
});

const CreateBody = z
  .object({
    name: z.string().min(1).max(120),
    /** Percentage form: 8.75 means 8.75% (NOT 0.0875). */
    ratePercent: z.union([z.string(), z.number()]),
  })
  .strict();

const UpdateBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    ratePercent: z.union([z.string(), z.number()]).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

function normaliseRate(v: string | number): string {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return 'NaN';
  return n.toFixed(4);
}

export const taxRatesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/tax-rates', async (req) => {
    const q = ListQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await tx
        .select()
        .from(taxRates)
        .where(q.active === undefined ? undefined : eq(taxRates.isActive, q.active === 'true'))
        .orderBy(asc(taxRates.name));
      return { taxRates: rows };
    });
  });

  app.post('/tax-rates', async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const ratePercent = normaliseRate(body.ratePercent);
    if (
      ratePercent === 'NaN' ||
      Number(ratePercent) < 0 ||
      Number(ratePercent) > 100
    ) {
      return reply
        .status(422)
        .send({ error: 'invalid_input', message: 'ratePercent must be 0..100' });
    }
    return req.withTenantTx(async (tx) => {
      try {
        const [created] = await tx
          .insert(taxRates)
          .values({
            companyId: req.auth!.companyId!,
            name: body.name.trim(),
            ratePercent,
          })
          .returning();
        return reply.status(201).send(created);
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === '23505'
        ) {
          return reply
            .status(409)
            .send({ error: 'duplicate_name', message: `tax rate "${body.name}" already exists` });
        }
        throw err;
      }
    });
  });

  app.patch('/tax-rates/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateBody.parse(req.body);
    return req.withTenantTx(async (tx) => {
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name.trim();
      if (body.ratePercent !== undefined) {
        const r = normaliseRate(body.ratePercent);
        if (r === 'NaN' || Number(r) < 0 || Number(r) > 100) {
          return reply
            .status(422)
            .send({ error: 'invalid_input', message: 'ratePercent must be 0..100' });
        }
        update.ratePercent = r;
      }
      if (body.isActive !== undefined) update.isActive = body.isActive;

      if (Object.keys(update).length === 0) {
        const [row] = await tx.select().from(taxRates).where(eq(taxRates.id, id));
        if (!row) return reply.status(404).send({ error: 'not_found' });
        return row;
      }
      try {
        const [updated] = await tx
          .update(taxRates)
          .set(update)
          .where(and(eq(taxRates.id, id)))
          .returning();
        if (!updated) return reply.status(404).send({ error: 'not_found' });
        return updated;
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === '23505'
        ) {
          return reply
            .status(409)
            .send({ error: 'duplicate_name', message: 'a tax rate with that name already exists' });
        }
        throw err;
      }
    });
  });
};
