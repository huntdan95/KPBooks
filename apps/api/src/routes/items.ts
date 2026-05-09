import { accounts, items } from '@kpbooks/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

/**
 * /v1/items routes -- service / non-inventory item catalog.
 *
 * Items are pre-set fixtures used to speed up invoice + bill line entry:
 * pick from a dropdown and the line auto-fills description, price/cost,
 * and the GL account. No journal-entry impact themselves; just metadata.
 */

const Decimal = z.union([z.string(), z.number()]);

const ItemTypeEnum = z.enum(['service', 'non_inventory']);

const ListQuery = z.object({
  active: z.enum(['true', 'false']).optional(),
  /** "sales" returns items with sales_account_id set; "purchase" the opposite. */
  side: z.enum(['sales', 'purchase']).optional(),
});

const CreateItem = z
  .object({
    name: z.string().min(1).max(120),
    sku: z.string().min(1).max(40).optional(),
    itemType: ItemTypeEnum.default('service'),
    salesDescription: z.string().max(500).optional(),
    salesPrice: Decimal.default('0'),
    salesAccountId: z.string().uuid().optional(),
    taxable: z.boolean().default(false),
    purchaseDescription: z.string().max(500).optional(),
    purchaseCost: Decimal.optional(),
    purchaseAccountId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.salesAccountId) || Boolean(v.purchaseAccountId),
    {
      message: 'item must have at least one of salesAccountId or purchaseAccountId',
      path: ['salesAccountId'],
    },
  );

const UpdateItem = z
  .object({
    name: z.string().min(1).max(120).optional(),
    sku: z.string().min(1).max(40).nullable().optional(),
    itemType: ItemTypeEnum.optional(),
    salesDescription: z.string().max(500).nullable().optional(),
    salesPrice: Decimal.optional(),
    salesAccountId: z.string().uuid().nullable().optional(),
    taxable: z.boolean().optional(),
    purchaseDescription: z.string().max(500).nullable().optional(),
    purchaseCost: Decimal.nullable().optional(),
    purchaseAccountId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

function decToString(v: string | number): string {
  return typeof v === 'number' ? v.toString() : v;
}

export const itemsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/items', async (req) => {
    const q = ListQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await tx
        .select()
        .from(items)
        .where(
          and(
            q.active === undefined ? undefined : eq(items.isActive, q.active === 'true'),
          ),
        )
        .orderBy(asc(items.name));
      const filtered = rows.filter((r) => {
        if (q.side === 'sales') return r.salesAccountId !== null;
        if (q.side === 'purchase') return r.purchaseAccountId !== null;
        return true;
      });
      return { items: filtered };
    });
  });

  app.get('/items/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const [row] = await tx.select().from(items).where(eq(items.id, id));
      if (!row) return reply.status(404).send({ error: 'not_found' });
      return row;
    });
  });

  app.post('/items', async (req, reply) => {
    const body = CreateItem.parse(req.body);
    return req.withTenantTx(async (tx) => {
      // Validate referenced accounts exist + active + match the expected type
      // (revenue for sales, expense for purchase). Catches the common "user
      // picked the wrong account in the dropdown" mistake at create time.
      const referencedIds = [body.salesAccountId, body.purchaseAccountId].filter(
        (x): x is string => Boolean(x),
      );
      if (referencedIds.length > 0) {
        const acctRows = await tx
          .select({ id: accounts.id, type: accounts.type, isActive: accounts.isActive })
          .from(accounts)
          .where(inArray(accounts.id, referencedIds));
        const byId = new Map(acctRows.map((r) => [r.id, r]));
        if (body.salesAccountId) {
          const a = byId.get(body.salesAccountId);
          if (!a) {
            return reply
              .status(422)
              .send({ error: 'unknown_account', message: 'salesAccountId not found' });
          }
          if (!a.isActive) {
            return reply
              .status(422)
              .send({ error: 'inactive_account', message: 'salesAccountId is inactive' });
          }
          if (a.type !== 'revenue') {
            return reply.status(422).send({
              error: 'wrong_account_type',
              message: 'salesAccountId must be a revenue account',
            });
          }
        }
        if (body.purchaseAccountId) {
          const a = byId.get(body.purchaseAccountId);
          if (!a) {
            return reply
              .status(422)
              .send({ error: 'unknown_account', message: 'purchaseAccountId not found' });
          }
          if (!a.isActive) {
            return reply.status(422).send({
              error: 'inactive_account',
              message: 'purchaseAccountId is inactive',
            });
          }
          if (a.type !== 'expense') {
            return reply.status(422).send({
              error: 'wrong_account_type',
              message: 'purchaseAccountId must be an expense account',
            });
          }
        }
      }

      const insertValues: typeof items.$inferInsert = {
        companyId: req.auth!.companyId!,
        name: body.name.trim(),
        itemType: body.itemType,
        salesPrice: decToString(body.salesPrice),
        taxable: body.taxable,
        ...(body.sku ? { sku: body.sku.trim() } : {}),
        ...(body.salesDescription ? { salesDescription: body.salesDescription } : {}),
        ...(body.salesAccountId ? { salesAccountId: body.salesAccountId } : {}),
        ...(body.purchaseDescription
          ? { purchaseDescription: body.purchaseDescription }
          : {}),
        ...(body.purchaseCost !== undefined
          ? { purchaseCost: decToString(body.purchaseCost) }
          : {}),
        ...(body.purchaseAccountId ? { purchaseAccountId: body.purchaseAccountId } : {}),
      };
      const [created] = await tx.insert(items).values(insertValues).returning();
      return reply.status(201).send(created);
    });
  });

  app.patch('/items/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateItem.parse(req.body);
    return req.withTenantTx(async (tx) => {
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) update.name = body.name.trim();
      if (body.sku !== undefined) update.sku = body.sku;
      if (body.itemType !== undefined) update.itemType = body.itemType;
      if (body.salesDescription !== undefined) update.salesDescription = body.salesDescription;
      if (body.salesPrice !== undefined) update.salesPrice = decToString(body.salesPrice);
      if (body.salesAccountId !== undefined) update.salesAccountId = body.salesAccountId;
      if (body.taxable !== undefined) update.taxable = body.taxable;
      if (body.purchaseDescription !== undefined)
        update.purchaseDescription = body.purchaseDescription;
      if (body.purchaseCost !== undefined)
        update.purchaseCost = body.purchaseCost === null ? null : decToString(body.purchaseCost);
      if (body.purchaseAccountId !== undefined) update.purchaseAccountId = body.purchaseAccountId;
      if (body.isActive !== undefined) update.isActive = body.isActive;

      const [updated] = await tx
        .update(items)
        .set(update)
        .where(eq(items.id, id))
        .returning();
      if (!updated) return reply.status(404).send({ error: 'not_found' });
      return updated;
    });
  });

  app.delete('/items/:id', async (req, reply) => {
    // Soft delete: set is_active=false. Preserves invoice/bill line history.
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const [updated] = await tx
        .update(items)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(items.id, id))
        .returning({ id: items.id });
      if (!updated) return reply.status(404).send({ error: 'not_found' });
      return reply.status(204).send();
    });
  });
};
