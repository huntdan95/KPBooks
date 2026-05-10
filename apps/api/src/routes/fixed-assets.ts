import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CreateFixedAssetSchema,
  DisposeAssetSchema,
  FixedAssetError,
  RunDepreciationSchema,
  UpdateFixedAssetSchema,
  createFixedAsset,
  deleteFixedAsset,
  disposeAsset,
  getFixedAsset,
  listFixedAssets,
  runDepreciationAll,
  runDepreciationForAsset,
  updateFixedAsset,
} from '../modules/fixed-assets/fixed-assets.service.js';

const errStatus = (code: FixedAssetError['code']): number => {
  switch (code) {
    case 'not_found':
      return 404;
    case 'wrong_status':
    case 'has_history':
    case 'fully_depreciated':
      return 409;
    case 'posting_failed':
      return 502;
    default:
      return 422;
  }
};

export const fixedAssetsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/fixed-assets', async (req) =>
    req.withTenantTx(async (tx) => ({ assets: await listFixedAssets(tx) })),
  );

  app.get('/fixed-assets/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const a = await getFixedAsset(tx, id);
      if (!a) return reply.status(404).send({ error: 'not_found' });
      return a;
    });
  });

  app.post('/fixed-assets', async (req, reply) => {
    const body = CreateFixedAssetSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        createFixedAsset(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof FixedAssetError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.patch('/fixed-assets/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateFixedAssetSchema.parse(req.body);
    try {
      await req.withTenantTx(async (tx) => updateFixedAsset(tx, id, body));
      return reply.send({ id });
    } catch (err) {
      if (err instanceof FixedAssetError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.delete('/fixed-assets/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      await req.withTenantTx(async (tx) => deleteFixedAsset(tx, id));
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof FixedAssetError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/fixed-assets/:id/run-depreciation', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = RunDepreciationSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        runDepreciationForAsset(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
          body.throughDate,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof FixedAssetError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/fixed-assets/run-depreciation', async (req, reply) => {
    const body = RunDepreciationSchema.parse(req.body);
    try {
      const results = await req.withTenantTx(async (tx) =>
        runDepreciationAll(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body.throughDate,
        ),
      );
      const totalMonths = results.reduce((acc, r) => acc + r.monthsPosted, 0);
      const totalEntries = results.reduce(
        (acc, r) => acc + r.journalEntryIds.length,
        0,
      );
      return reply.status(201).send({
        results,
        summary: {
          assetsProcessed: results.length,
          assetsWithPostings: results.filter((r) => r.monthsPosted > 0).length,
          totalMonthsPosted: totalMonths,
          totalEntriesPosted: totalEntries,
        },
      });
    } catch (err) {
      if (err instanceof FixedAssetError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/fixed-assets/:id/dispose', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = DisposeAssetSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        disposeAsset(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof FixedAssetError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
