import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CreateRecurringSchema,
  RecurringError,
  UpdateRecurringSchema,
  createRecurring,
  deleteRecurring,
  getRecurring,
  listRecurring,
  runAllDue,
  runRecurring,
  updateRecurring,
} from '../modules/recurring/recurring.service.js';

const ListQuery = z.object({
  kind: z.enum(['invoice', 'bill']).optional(),
  active: z.enum(['true', 'false']).optional(),
});

const errStatus = (code: RecurringError['code']): number => {
  switch (code) {
    case 'not_found':
      return 404;
    case 'inactive':
    case 'past_end_date':
      return 409;
    default:
      return 422;
  }
};

export const recurringRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/recurring', async (req) => {
    const q = ListQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await listRecurring(tx, {
        kind: q.kind,
        activeOnly: q.active === 'true' ? true : q.active === 'false' ? false : undefined,
      });
      return { templates: rows };
    });
  });

  app.get('/recurring/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const row = await getRecurring(tx, id);
      if (!row) return reply.status(404).send({ error: 'not_found' });
      return row;
    });
  });

  app.post('/recurring', async (req, reply) => {
    const body = CreateRecurringSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        createRecurring(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof RecurringError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.patch('/recurring/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateRecurringSchema.parse(req.body);
    try {
      await req.withTenantTx(async (tx) => updateRecurring(tx, id, body));
      return reply.send({ id });
    } catch (err) {
      if (err instanceof RecurringError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.delete('/recurring/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const ok = await deleteRecurring(tx, id);
      if (!ok) return reply.status(404).send({ error: 'not_found' });
      return reply.status(204).send();
    });
  });

  app.post('/recurring/:id/run', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.body ?? {});
    try {
      const result = await req.withTenantTx(async (tx) =>
        runRecurring(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
          body.documentDate ? { documentDate: body.documentDate } : {},
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof RecurringError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/recurring/run-all-due', async (req, reply) => {
    const body = z
      .object({
        asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.body ?? {});
    const result = await req.withTenantTx(async (tx) =>
      runAllDue(
        tx,
        { companyId: req.auth!.companyId!, userId: req.auth!.userId },
        body.asOf,
      ),
    );
    return reply.send(result);
  });
};
