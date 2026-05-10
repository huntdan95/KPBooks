import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  DocumentError,
  ListDocumentsQuerySchema,
  UpdateDocumentSchema,
  UploadDocumentSchema,
  deleteDocument,
  downloadDocument,
  getDocument,
  listDocuments,
  restoreDocument,
  updateDocument,
  uploadDocument,
} from '../modules/documents/documents.service.js';

const errStatus = (code: DocumentError['code']): number => {
  switch (code) {
    case 'not_found':
      return 404;
    case 'wrong_status':
      return 409;
    case 'file_too_large':
      return 413;
    case 'unsupported_mime':
    case 'empty_file':
      return 415;
    default:
      return 422;
  }
};

export const documentsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/documents', async (req) => {
    const filter = ListDocumentsQuerySchema.parse(req.query);
    return req.withTenantTx(async (tx) => ({
      filter,
      documents: await listDocuments(tx, filter),
    }));
  });

  app.get('/documents/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const row = await getDocument(tx, id);
      if (!row) return reply.status(404).send({ error: 'not_found' });
      return row;
    });
  });

  app.get('/documents/:id/download', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const file = await downloadDocument(tx, id);
      if (!file) return reply.status(404).send({ error: 'not_found' });
      const safeName = file.filename.replace(/[^\w.\-]+/g, '_');
      reply.header('Content-Type', file.mimeType);
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
      reply.header('Content-Length', String(file.data.length));
      return reply.send(file.data);
    });
  });

  app.post('/documents', async (req, reply) => {
    const body = UploadDocumentSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        uploadDocument(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof DocumentError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.patch('/documents/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateDocumentSchema.parse(req.body);
    try {
      await req.withTenantTx(async (tx) =>
        updateDocument(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
          body,
        ),
      );
      return reply.send({ id });
    } catch (err) {
      if (err instanceof DocumentError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.delete('/documents/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      await req.withTenantTx(async (tx) =>
        deleteDocument(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
        ),
      );
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof DocumentError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/documents/:id/restore', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      await req.withTenantTx(async (tx) =>
        restoreDocument(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
        ),
      );
      return reply.send({ id });
    } catch (err) {
      if (err instanceof DocumentError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
