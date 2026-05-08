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
