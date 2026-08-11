import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CreateWorkerSchema,
  UpdateWorkerSchema,
  UploadDocumentSchema,
  WorkerError,
  createWorker,
  deleteDocument,
  downloadDocument,
  getWorker,
  listWorkers,
  updateWorker,
  uploadDocument,
} from '../modules/workers/workers.service.js';

const ListQuery = z.object({
  workerType: z.enum(['contractor', 'subcontractor', 'employee']).optional(),
  active: z.enum(['true', 'false']).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

const errStatus = (code: WorkerError['code']): number => {
  switch (code) {
    case 'not_found':
      return 404;
    case 'duplicate_vendor':
      return 409;
    case 'file_too_large':
      return 413;
    default:
      return 422;
  }
};

export const workersRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/workers', async (req) => {
    const q = ListQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await listWorkers(tx, {
        workerType: q.workerType,
        activeOnly: q.active === 'true' ? true : q.active === 'false' ? false : undefined,
        year: q.year,
      });
      return { workers: rows, year: q.year ?? new Date().getUTCFullYear() };
    });
  });

  app.post('/workers', async (req, reply) => {
    const body = CreateWorkerSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        createWorker(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof WorkerError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/workers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { year } = z
      .object({ year: z.coerce.number().int().min(2000).max(2100).optional() })
      .parse(req.query);
    return req.withTenantTx(async (tx) => {
      const data = await getWorker(tx, id, year ?? new Date().getUTCFullYear());
      if (!data) return reply.status(404).send({ error: 'not_found' });
      return data;
    });
  });

  app.patch('/workers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateWorkerSchema.parse(req.body);
    try {
      await req.withTenantTx(async (tx) => updateWorker(tx, id, body));
      return reply.send({ id });
    } catch (err) {
      if (err instanceof WorkerError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/workers/:id/documents', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UploadDocumentSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        uploadDocument(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof WorkerError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/workers/:id/documents/:docId/download', async (req, reply) => {
    const { docId } = z
      .object({ id: z.string().uuid(), docId: z.string().uuid() })
      .parse(req.params);
    return req.withTenantTx(async (tx) => {
      const doc = await downloadDocument(tx, docId);
      if (!doc) return reply.status(404).send({ error: 'not_found' });
      const safeFileName = doc.fileName.replace(/[\r\n"]/g, '_');
      reply.header('Content-Type', doc.mimeType);
      reply.header(
        'Content-Disposition',
        `attachment; filename="${safeFileName}"`,
      );
      reply.header('Content-Length', String(doc.data.length));
      return reply.send(doc.data);
    });
  });

  app.delete('/workers/:id/documents/:docId', async (req, reply) => {
    const { docId } = z
      .object({ id: z.string().uuid(), docId: z.string().uuid() })
      .parse(req.params);
    return req.withTenantTx(async (tx) => {
      const ok = await deleteDocument(tx, docId);
      if (!ok) return reply.status(404).send({ error: 'not_found' });
      return reply.status(204).send();
    });
  });
};
