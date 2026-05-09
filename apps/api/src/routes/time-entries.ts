import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  BuildBillSchema,
  CreateTimeEntrySchema,
  TimeEntryError,
  UpdateTimeEntrySchema,
  buildBillFromEntries,
  createTimeEntry,
  deleteTimeEntry,
  listTimeEntries,
  unbilledSummaryByVendor,
  updateTimeEntry,
} from '../modules/time-entries/time-entries.service.js';

const ListQuery = z.object({
  vendorId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  unbilledOnly: z.enum(['true', 'false']).optional(),
});

const errStatus = (code: TimeEntryError['code']): number => {
  switch (code) {
    case 'not_found':
      return 404;
    case 'already_billed':
    case 'no_unbilled_entries':
      return 409;
    case 'bill_create_failed':
      return 502;
    default:
      return 422;
  }
};

export const timeEntriesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/time-entries', async (req) => {
    const q = ListQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await listTimeEntries(tx, {
        vendorId: q.vendorId,
        from: q.from,
        to: q.to,
        unbilledOnly: q.unbilledOnly === 'true',
      });
      return { entries: rows };
    });
  });

  app.get('/time-entries/unbilled-summary', async (req) => {
    return req.withTenantTx(async (tx) => {
      const summary = await unbilledSummaryByVendor(tx);
      return { vendors: summary };
    });
  });

  app.post('/time-entries', async (req, reply) => {
    const body = CreateTimeEntrySchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        createTimeEntry(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof TimeEntryError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.patch('/time-entries/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateTimeEntrySchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) => updateTimeEntry(tx, id, body));
      return reply.send(result);
    } catch (err) {
      if (err instanceof TimeEntryError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.delete('/time-entries/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      await req.withTenantTx(async (tx) => deleteTimeEntry(tx, id));
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof TimeEntryError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/time-entries/build-bill', async (req, reply) => {
    const body = BuildBillSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        buildBillFromEntries(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof TimeEntryError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
