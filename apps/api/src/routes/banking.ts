import { bankRules, accounts } from '@kpbooks/db';
import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isAvailable as anthropicAvailable } from '../modules/ai/anthropic.js';
import {
  BankingError,
  ImportCsvSchema,
  importBankCsv,
  ignoreBankTransaction,
  listBankTransactions,
  postBankTransaction,
  suggestCategoriesForBatch,
} from '../modules/banking/banking.service.js';
import {
  ReconciliationError,
  StartSchema,
  finaliseReconciliation,
  getReconciliationSummary,
  listReconciliations,
  reopenReconciliation,
  setTransactionCleared,
  startReconciliation,
} from '../modules/banking/reconciliation.service.js';

const ListQuery = z.object({
  status: z.enum(['unmatched', 'suggested', 'posted', 'ignored']).optional(),
  bankAccountId: z.string().uuid().optional(),
});

const SuggestBody = z
  .object({
    bankTransactionIds: z.array(z.string().uuid()).min(1).max(50),
  })
  .strict();

const PostBody = z
  .object({
    accountId: z.string().uuid().optional(),
  })
  .strict();

const MatchType = z.enum(['contains', 'starts_with', 'ends_with', 'exact', 'regex']);
const AmountSign = z.enum(['any', 'positive', 'negative']);

const CreateRule = z
  .object({
    name: z.string().min(1).max(120),
    matchType: MatchType.default('contains'),
    matchValue: z.string().min(1).max(500),
    amountSign: AmountSign.default('any'),
    targetAccountId: z.string().uuid(),
    bankAccountId: z.string().uuid().optional(),
    memoTemplate: z.string().max(500).optional(),
    priority: z.number().int().min(0).max(10000).default(100),
  })
  .strict();

const UpdateRule = z
  .object({
    name: z.string().min(1).max(120).optional(),
    matchType: MatchType.optional(),
    matchValue: z.string().min(1).max(500).optional(),
    amountSign: AmountSign.optional(),
    targetAccountId: z.string().uuid().optional(),
    bankAccountId: z.string().uuid().nullable().optional(),
    memoTemplate: z.string().max(500).nullable().optional(),
    priority: z.number().int().min(0).max(10000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const bankingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  /** Returns whether the AI suggestion endpoint is wired up (key configured). */
  app.get('/banking/ai-status', async () => {
    return { available: anthropicAvailable() };
  });

  app.post('/banking/import-csv', async (req, reply) => {
    const body = ImportCsvSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        importBankCsv(tx, { companyId: req.auth!.companyId!, userId: req.auth!.userId }, body),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof BankingError) {
        return reply.status(422).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/banking/transactions', async (req) => {
    const q = ListQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await listBankTransactions(tx, q);
      return { transactions: rows };
    });
  });

  app.post('/banking/categorize-suggest', async (req, reply) => {
    const body = SuggestBody.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        suggestCategoriesForBatch(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body.bankTransactionIds,
        ),
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof BankingError) {
        const status = err.code === 'ai_unavailable' ? 503 : err.code === 'ai_failed' ? 502 : 422;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/banking/transactions/:id/post', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = PostBody.parse(req.body ?? {});
    try {
      const result = await req.withTenantTx(async (tx) =>
        postBankTransaction(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
          body.accountId,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof BankingError) {
        const status =
          err.code === 'not_found' ? 404 : err.code === 'wrong_status' ? 409 : 422;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/banking/transactions/:id/ignore', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      const result = await req.withTenantTx(async (tx) =>
        ignoreBankTransaction(tx, id),
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof BankingError) {
        const status =
          err.code === 'not_found' ? 404 : err.code === 'wrong_status' ? 409 : 422;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // -------------------- Bank rule routes --------------------------

  app.get('/banking/rules', async (req) => {
    return req.withTenantTx(async (tx) => {
      const rows = await tx
        .select()
        .from(bankRules)
        .orderBy(asc(bankRules.priority), desc(bankRules.createdAt));
      return { rules: rows };
    });
  });

  app.post('/banking/rules', async (req, reply) => {
    const body = CreateRule.parse(req.body);
    return req.withTenantTx(async (tx) => {
      // Sanity-check the target account exists, is in the same tenant (RLS),
      // and isn't a bank/AR/AP/equity contra-account that would lead to bad postings.
      const [target] = await tx
        .select({ id: accounts.id, isActive: accounts.isActive, subtype: accounts.subtype })
        .from(accounts)
        .where(eq(accounts.id, body.targetAccountId));
      if (!target) {
        return reply.status(422).send({ error: 'invalid_target', message: 'target account not found' });
      }
      if (!target.isActive) {
        return reply
          .status(422)
          .send({ error: 'invalid_target', message: 'target account is inactive' });
      }
      if (target.subtype === 'accounts_receivable' || target.subtype === 'accounts_payable') {
        return reply.status(422).send({
          error: 'invalid_target',
          message: 'bank-side rules cannot target A/R or A/P; use a revenue or expense account',
        });
      }

      const insert: typeof bankRules.$inferInsert = {
        companyId: req.auth!.companyId!,
        name: body.name,
        matchType: body.matchType,
        matchValue: body.matchValue,
        amountSign: body.amountSign,
        targetAccountId: body.targetAccountId,
        priority: body.priority,
        ...(body.bankAccountId ? { bankAccountId: body.bankAccountId } : {}),
        ...(body.memoTemplate ? { memoTemplate: body.memoTemplate } : {}),
      };
      const [created] = await tx.insert(bankRules).values(insert).returning();
      return reply.status(201).send(created);
    });
  });

  app.patch('/banking/rules/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateRule.parse(req.body);
    return req.withTenantTx(async (tx) => {
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) update.name = body.name;
      if (body.matchType !== undefined) update.matchType = body.matchType;
      if (body.matchValue !== undefined) update.matchValue = body.matchValue;
      if (body.amountSign !== undefined) update.amountSign = body.amountSign;
      if (body.targetAccountId !== undefined) update.targetAccountId = body.targetAccountId;
      if (body.bankAccountId !== undefined) update.bankAccountId = body.bankAccountId;
      if (body.memoTemplate !== undefined) update.memoTemplate = body.memoTemplate;
      if (body.priority !== undefined) update.priority = body.priority;
      if (body.isActive !== undefined) update.isActive = body.isActive;
      const [updated] = await tx
        .update(bankRules)
        .set(update)
        .where(eq(bankRules.id, id))
        .returning();
      if (!updated) return reply.status(404).send({ error: 'not_found' });
      return updated;
    });
  });

  app.delete('/banking/rules/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const result = await tx.delete(bankRules).where(eq(bankRules.id, id)).returning();
      if (result.length === 0) return reply.status(404).send({ error: 'not_found' });
      return reply.status(204).send();
    });
  });

  // -------------------- Reconciliation routes ---------------------

  const reconErrStatus = (code: ReconciliationError['code']): number => {
    switch (code) {
      case 'not_found':
        return 404;
      case 'in_progress_exists':
      case 'wrong_status':
        return 409;
      default:
        return 422;
    }
  };

  app.get('/banking/reconciliations', async (req) => {
    const q = z
      .object({
        bankAccountId: z.string().uuid().optional(),
        status: z.enum(['in_progress', 'completed']).optional(),
      })
      .parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await listReconciliations(tx, q);
      return { reconciliations: rows };
    });
  });

  app.post('/banking/reconciliations', async (req, reply) => {
    const body = StartSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        startReconciliation(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof ReconciliationError) {
        return reply.status(reconErrStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/banking/reconciliations/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      const result = await req.withTenantTx(async (tx) => getReconciliationSummary(tx, id));
      return reply.send(result);
    } catch (err) {
      if (err instanceof ReconciliationError) {
        return reply.status(reconErrStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/banking/reconciliations/:id/clear', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ bankTransactionId: z.string().uuid(), cleared: z.boolean() })
      .parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        setTransactionCleared(tx, id, body.bankTransactionId, body.cleared),
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof ReconciliationError) {
        return reply.status(reconErrStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/banking/reconciliations/:id/finalise', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      const result = await req.withTenantTx(async (tx) =>
        finaliseReconciliation(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
        ),
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof ReconciliationError) {
        return reply.status(reconErrStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/banking/reconciliations/:id/reopen', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const role = req.auth!.role;
    if (role !== 'owner' && role !== 'admin') {
      return reply.status(403).send({ error: 'forbidden', message: 'requires owner or admin' });
    }
    try {
      const result = await req.withTenantTx(async (tx) => reopenReconciliation(tx, id));
      return reply.send(result);
    } catch (err) {
      if (err instanceof ReconciliationError) {
        return reply.status(reconErrStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
