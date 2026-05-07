import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get('/readyz', async (req, reply) => {
    try {
      const r = await app.db.execute(sql`SELECT 1 AS ok`);
      // Drizzle's postgres-js execute returns an array-like of rows.
      const ok = Array.isArray(r) ? r.length > 0 : true;
      if (!ok) throw new Error('db ping returned empty');
      return { ok: true };
    } catch (err) {
      req.log.error({ err }, 'readyz failed');
      return reply.status(503).send({ ok: false });
    }
  });
};
