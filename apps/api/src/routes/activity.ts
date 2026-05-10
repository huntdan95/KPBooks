import type { FastifyPluginAsync } from 'fastify';
import {
  ListActivityQuerySchema,
  listActivity,
} from '../modules/activity/activity.service.js';

export const activityRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/activity', async (req) => {
    const filter = ListActivityQuerySchema.parse(req.query);
    return req.withTenantTx(async (tx) => ({
      filter,
      rows: await listActivity(tx, filter),
    }));
  });
};
