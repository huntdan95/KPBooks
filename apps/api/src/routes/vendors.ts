import { vendors } from '@kpbooks/db';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const Address = z
  .object({
    street1: z.string().max(200).optional(),
    street2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(60).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().max(60).optional(),
  })
  .strict()
  .partial();

const ListQuery = z.object({
  active: z.enum(['true', 'false']).optional(),
  is1099: z.enum(['true', 'false']).optional(),
});

const Create = z
  .object({
    displayName: z.string().min(1).max(200),
    companyName: z.string().max(200).optional(),
    accountNumber: z.string().min(1).max(40).optional(),
    email: z.string().email().max(200).optional(),
    phone: z.string().max(40).optional(),
    mailingAddress: Address.optional(),
    defaultTermsDays: z.number().int().min(0).max(365).optional(),
    is1099Vendor: z.boolean().default(false),
    taxId: z.string().max(40).optional(),
    notes: z.string().max(2000).optional(),
    openingBalance: z.union([z.string(), z.number()]).default('0'),
    openingBalanceDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
      .optional(),
  })
  .strict()
  .refine(
    (v) => !v.is1099Vendor || (v.taxId && v.taxId.length > 0),
    { message: '1099 vendors require a tax ID', path: ['taxId'] },
  );

export const vendorsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/vendors', async (req) => {
    const q = ListQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await tx
        .select()
        .from(vendors)
        .where(
          and(
            q.active === undefined ? undefined : eq(vendors.isActive, q.active === 'true'),
            q.is1099 === undefined ? undefined : eq(vendors.is1099Vendor, q.is1099 === 'true'),
          ),
        )
        .orderBy(asc(vendors.displayName));
      return { vendors: rows };
    });
  });

  app.post('/vendors', async (req, reply) => {
    const body = Create.parse(req.body);
    return req.withTenantTx(async (tx) => {
      const [created] = await tx
        .insert(vendors)
        .values({
          companyId: req.auth!.companyId!,
          displayName: body.displayName,
          companyName: body.companyName ?? null,
          accountNumber: body.accountNumber ?? null,
          email: body.email ?? null,
          phone: body.phone ?? null,
          mailingAddress: body.mailingAddress ?? null,
          defaultTermsDays: body.defaultTermsDays ?? null,
          is1099Vendor: body.is1099Vendor,
          taxId: body.taxId ?? null,
          notes: body.notes ?? null,
          openingBalance: typeof body.openingBalance === 'number'
            ? body.openingBalance.toString()
            : body.openingBalance,
          openingBalanceDate: body.openingBalanceDate ?? null,
        })
        .returning();
      return reply.status(201).send(created);
    });
  });

  app.get('/vendors/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const [row] = await tx.select().from(vendors).where(eq(vendors.id, id));
      if (!row) return reply.status(404).send({ error: 'not_found' });
      return row;
    });
  });

  app.patch('/vendors/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Use the inner schema (without the refine) so partial updates don't trip
    // the "1099 needs tax ID" check on every patch — we re-validate the final
    // state below.
    const Patch = z
      .object({
        displayName: z.string().min(1).max(200).optional(),
        companyName: z.string().max(200).nullable().optional(),
        accountNumber: z.string().min(1).max(40).nullable().optional(),
        email: z.string().email().max(200).nullable().optional(),
        phone: z.string().max(40).nullable().optional(),
        mailingAddress: Address.nullable().optional(),
        defaultTermsDays: z.number().int().min(0).max(365).nullable().optional(),
        is1099Vendor: z.boolean().optional(),
        taxId: z.string().max(40).nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
        isActive: z.boolean().optional(),
        openingBalance: z.union([z.string(), z.number()]).optional(),
        openingBalanceDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
          .nullable()
          .optional(),
      })
      .strict();
    const body = Patch.parse(req.body);

    return req.withTenantTx(async (tx) => {
      const [existing] = await tx.select().from(vendors).where(eq(vendors.id, id));
      if (!existing) return reply.status(404).send({ error: 'not_found' });

      const merged = {
        is1099Vendor: body.is1099Vendor ?? existing.is1099Vendor,
        taxId: body.taxId !== undefined ? body.taxId : existing.taxId,
      };
      if (merged.is1099Vendor && (!merged.taxId || merged.taxId.length === 0)) {
        return reply
          .status(400)
          .send({ error: 'validation_failed', message: '1099 vendors require a tax ID' });
      }

      const update: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        update[k] = k === 'openingBalance' && typeof v === 'number' ? v.toString() : v;
      }
      if (Object.keys(update).length === 0) return existing;

      const [updated] = await tx
        .update(vendors)
        .set(update)
        .where(eq(vendors.id, id))
        .returning();
      return updated;
    });
  });
};
