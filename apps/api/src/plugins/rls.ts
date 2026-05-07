import type { Database } from '@kpbooks/db';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { sql as drizzleSql } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyRequest {
    /** Run a callback inside a Postgres transaction with RLS GUCs set. */
    withTenantTx: <T>(fn: (tx: Database) => Promise<T>) => Promise<T>;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('withTenantTx', null);

  app.addHook('onRequest', async function setTenantTxRunner(req: FastifyRequest) {
    req.withTenantTx = async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
      if (!req.auth) {
        throw app.httpErrors.unauthorized('authentication required before tenant transaction');
      }
      if (!req.auth.companyId) {
        throw app.httpErrors.badRequest('x-kpbooks-company header required');
      }
      const { companyId, userId, role } = req.auth;

      return app.db.transaction(async (tx) => {
        // SET LOCAL is scoped to this transaction; subsequent queries on `tx`
        // see the GUCs and RLS policies fire as designed.
        await tx.execute(drizzleSql`SELECT set_config('app.current_company', ${companyId}, true)`);
        await tx.execute(drizzleSql`SELECT set_config('app.current_user', ${userId}, true)`);
        await tx.execute(drizzleSql`SELECT set_config('app.current_role', ${role ?? ''}, true)`);
        return fn(tx);
      });
    };
  });
};

export const rlsContextPlugin = fp(plugin, { name: 'rls-context', dependencies: ['db', 'firebase-auth'] });
