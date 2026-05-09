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
  app.decorateRequest('withTenantTx', function withTenantTxUninitialized<T>(
    this: FastifyRequest,
    _fn: (tx: Database) => Promise<T>,
  ): Promise<T> {
    return Promise.reject(new Error('withTenantTx not initialised — onRequest hook missing'));
  });

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
        // CRITICAL: switch out of the connection role (neondb_owner has the
        // BYPASSRLS attribute, which silently disables every RLS policy and
        // even FORCE ROW LEVEL SECURITY) into the sibling role kpbooks_app,
        // which is NOBYPASSRLS. This is what keeps cross-tenant queries from
        // leaking. SET LOCAL is transaction-scoped, so the connection
        // reverts to neondb_owner after commit/rollback. See migration
        // 0029_app_user_role.sql for the full root-cause writeup.
        await tx.execute(drizzleSql`SET LOCAL ROLE kpbooks_app`);

        // GUCs the RLS policies + audit triggers read.
        await tx.execute(drizzleSql`SELECT set_config('app.current_company', ${companyId}, true)`);
        await tx.execute(drizzleSql`SELECT set_config('app.current_user', ${userId}, true)`);
        await tx.execute(drizzleSql`SELECT set_config('app.current_role', ${role ?? ''}, true)`);
        return fn(tx);
      });
    };
  });
};

export const rlsContextPlugin = fp(plugin, { name: 'rls-context', dependencies: ['db', 'firebase-auth'] });
