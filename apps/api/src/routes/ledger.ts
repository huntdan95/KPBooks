import { accounts } from '@kpbooks/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PostingError, postEntry, postingSchemas } from '../modules/ledger/posting.service.js';
import {
  apAging,
  arAging,
  balanceSheet,
  profitAndLoss,
  trialBalance,
} from '../modules/ledger/reports.service.js';

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const ListAccountsQuery = z.object({
  active: z.enum(['true', 'false']).optional(),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']).optional(),
});

const CreateAccount = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  subtype: z.string().min(1),
  parentId: z.string().uuid().optional(),
  currency: z.string().min(3).max(8).default('USD'),
  description: z.string().max(500).optional(),
});

// PATCH only allows safe-to-change fields. type/subtype/parentId/companyId are
// structural and changing them would invalidate posted journal lines, so we
// reject those at the API layer rather than at the DB. Use a new account if
// you need a different category.
const UpdateAccount = z
  .object({
    code: z.string().min(1).max(40).optional(),
    name: z.string().min(1).max(120).optional(),
    currency: z.string().min(3).max(8).optional(),
    description: z.string().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const ledgerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/ledger/accounts', async (req) => {
    const q = ListAccountsQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await tx
        .select()
        .from(accounts)
        .where(
          and(
            q.active === undefined ? undefined : eq(accounts.isActive, q.active === 'true'),
            q.type === undefined ? undefined : eq(accounts.type, q.type),
          ),
        );
      return { accounts: rows };
    });
  });

  app.post('/ledger/accounts', async (req, reply) => {
    const body = CreateAccount.parse(req.body);
    return req.withTenantTx(async (tx) => {
      const [created] = await tx
        .insert(accounts)
        .values({
          companyId: req.auth!.companyId!,
          code: body.code,
          name: body.name,
          type: body.type,
          subtype: body.subtype as never,
          parentId: body.parentId ?? null,
          currency: body.currency,
          description: body.description ?? null,
        })
        .returning();
      return reply.status(201).send(created);
    });
  });

  app.patch('/ledger/accounts/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateAccount.parse(req.body);
    return req.withTenantTx(async (tx) => {
      const update: Record<string, unknown> = {};
      if (body.code !== undefined) update.code = body.code;
      if (body.name !== undefined) update.name = body.name;
      if (body.currency !== undefined) update.currency = body.currency;
      if (body.description !== undefined) update.description = body.description;
      if (body.isActive !== undefined) update.isActive = body.isActive;

      if (Object.keys(update).length === 0) {
        const [row] = await tx.select().from(accounts).where(eq(accounts.id, id));
        if (!row) return reply.status(404).send({ error: 'not_found' });
        return row;
      }

      const [updated] = await tx
        .update(accounts)
        .set(update)
        .where(eq(accounts.id, id))
        .returning();
      if (!updated) return reply.status(404).send({ error: 'not_found' });
      return updated;
    });
  });

  app.post('/ledger/journal-entries', async (req, reply) => {
    const body = postingSchemas.PostEntrySchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        postEntry(tx, { companyId: req.auth!.companyId!, userId: req.auth!.userId }, body),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof PostingError) {
        return reply.status(422).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/ledger/reports/trial-balance', async (req) => {
    const { asOf } = z.object({ asOf: DateOnly }).parse(req.query);
    return req.withTenantTx(async (tx) => ({ asOf, rows: await trialBalance(tx, asOf) }));
  });

  app.get('/ledger/reports/pnl', async (req) => {
    const { start, end, basis } = z
      .object({
        start: DateOnly,
        end: DateOnly,
        basis: z.enum(['accrual', 'cash']).default('accrual'),
      })
      .parse(req.query);
    return req.withTenantTx(async (tx) => profitAndLoss(tx, start, end, basis));
  });

  app.get('/ledger/reports/balance-sheet', async (req) => {
    const { asOf } = z.object({ asOf: DateOnly }).parse(req.query);
    return req.withTenantTx(async (tx) => balanceSheet(tx, asOf));
  });

  app.get('/ledger/reports/ar-aging', async (req) => {
    const { asOf } = z.object({ asOf: DateOnly }).parse(req.query);
    return req.withTenantTx(async (tx) => arAging(tx, asOf));
  });

  app.get('/ledger/reports/ap-aging', async (req) => {
    const { asOf } = z.object({ asOf: DateOnly }).parse(req.query);
    return req.withTenantTx(async (tx) => apAging(tx, asOf));
  });
};
