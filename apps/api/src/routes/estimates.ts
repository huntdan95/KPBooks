import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CreateEstimateSchema,
  EstimateError,
  UpdateEstimateSchema,
  convertEstimateToInvoice,
  createEstimate,
  deleteEstimate,
  getEstimate,
  listEstimates,
  setEstimateStatus,
  updateEstimate,
} from '../modules/estimates/estimates.service.js';

const ListQuery = z.object({
  status: z
    .enum(['draft', 'sent', 'accepted', 'declined', 'expired', 'converted'])
    .optional(),
});

const StatusBody = z
  .object({
    status: z.enum(['draft', 'sent', 'accepted', 'declined', 'expired']),
  })
  .strict();

const ConvertBody = z
  .object({
    invoiceNumber: z.string().min(1).max(40),
    invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
  })
  .strict();

const errStatus = (code: EstimateError['code']): number => {
  switch (code) {
    case 'not_found':
      return 404;
    case 'duplicate_number':
      return 409;
    case 'wrong_status':
      return 409;
    default:
      return 422;
  }
};

export const estimatesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/estimates', async (req) => {
    const q = ListQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await listEstimates(tx, q);
      return { estimates: rows };
    });
  });

  app.get('/estimates/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const data = await getEstimate(tx, id);
      if (!data) return reply.status(404).send({ error: 'not_found' });
      return data;
    });
  });

  app.post('/estimates', async (req, reply) => {
    const body = CreateEstimateSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        createEstimate(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof EstimateError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.patch('/estimates/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateEstimateSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        updateEstimate(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
          body,
        ),
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof EstimateError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.delete('/estimates/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      await req.withTenantTx(async (tx) => deleteEstimate(tx, id));
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof EstimateError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/estimates/:id/status', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = StatusBody.parse(req.body);
    try {
      await req.withTenantTx(async (tx) => setEstimateStatus(tx, id, body.status));
      return reply.send({ id, status: body.status });
    } catch (err) {
      if (err instanceof EstimateError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/estimates/:id/convert', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = ConvertBody.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        convertEstimateToInvoice(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof EstimateError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
