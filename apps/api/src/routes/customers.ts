import { customers } from '@kpbooks/db';
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
});

const Create = z
  .object({
    displayName: z.string().min(1).max(200),
    companyName: z.string().max(200).optional(),
    accountNumber: z.string().min(1).max(40).optional(),
    email: z.string().email().max(200).optional(),
    phone: z.string().max(40).optional(),
    billingAddress: Address.optional(),
    shippingAddress: Address.optional(),
    defaultTermsDays: z.number().int().min(0).max(365).optional(),
    taxExempt: z.boolean().default(false),
    taxId: z.string().max(40).optional(),
    notes: z.string().max(2000).optional(),
    openingBalance: z.union([z.string(), z.number()]).default('0'),
    openingBalanceDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
      .optional(),
  })
  .strict();

export const customersRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/customers', async (req) => {
    const q = ListQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await tx
        .select()
        .from(customers)
        .where(q.active === undefined ? undefined : eq(customers.isActive, q.active === 'true'))
        .orderBy(asc(customers.displayName));
      return { customers: rows };
    });
  });

  app.post('/customers', async (req, reply) => {
    const body = Create.parse(req.body);
    return req.withTenantTx(async (tx) => {
      const [created] = await tx
        .insert(customers)
        .values({
          companyId: req.auth!.companyId!,
          displayName: body.displayName,
          companyName: body.companyName ?? null,
          accountNumber: body.accountNumber ?? null,
          email: body.email ?? null,
          phone: body.phone ?? null,
          billingAddress: body.billingAddress ?? null,
          shippingAddress: body.shippingAddress ?? null,
          defaultTermsDays: body.defaultTermsDays ?? null,
          taxExempt: body.taxExempt,
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

  app.get('/customers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const [row] = await tx.select().from(customers).where(eq(customers.id, id));
      if (!row) return reply.status(404).send({ error: 'not_found' });
      return row;
    });
  });

  app.patch('/customers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = Create.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
    return req.withTenantTx(async (tx) => {
      const update: Record<string, unknown> = {};
      if (body.displayName !== undefined) update.displayName = body.displayName;
      if (body.companyName !== undefined) update.companyName = body.companyName;
      if (body.accountNumber !== undefined) update.accountNumber = body.accountNumber;
      if (body.email !== undefined) update.email = body.email;
      if (body.phone !== undefined) update.phone = body.phone;
      if (body.billingAddress !== undefined) update.billingAddress = body.billingAddress;
      if (body.shippingAddress !== undefined) update.shippingAddress = body.shippingAddress;
      if (body.defaultTermsDays !== undefined) update.defaultTermsDays = body.defaultTermsDays;
      if (body.taxExempt !== undefined) update.taxExempt = body.taxExempt;
      if (body.taxId !== undefined) update.taxId = body.taxId;
      if (body.notes !== undefined) update.notes = body.notes;
      if (body.isActive !== undefined) update.isActive = body.isActive;
      if (body.openingBalance !== undefined) {
        update.openingBalance =
          typeof body.openingBalance === 'number' ? body.openingBalance.toString() : body.openingBalance;
      }
      if (body.openingBalanceDate !== undefined) update.openingBalanceDate = body.openingBalanceDate;

      if (Object.keys(update).length === 0) {
        const [row] = await tx.select().from(customers).where(eq(customers.id, id));
        if (!row) return reply.status(404).send({ error: 'not_found' });
        return row;
      }

      const [updated] = await tx
        .update(customers)
        .set(update)
        .where(and(eq(customers.id, id)))
        .returning();
      if (!updated) return reply.status(404).send({ error: 'not_found' });
      return updated;
    });
  });
};
