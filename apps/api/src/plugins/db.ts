import { createClient, type Database, type DatabaseClient } from '@kpbooks/db';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    sql: DatabaseClient;
  }
}

interface DbPluginOptions {
  url: string;
  max?: number;
}

const plugin: FastifyPluginAsync<DbPluginOptions> = async (app, opts) => {
  const { sql, db } = createClient({ url: opts.url, max: opts.max ?? 10 });
  app.decorate('db', db);
  app.decorate('sql', sql);
  app.addHook('onClose', async () => {
    await sql.end({ timeout: 5 });
  });
};

export const dbPlugin = fp(plugin, { name: 'db' });
