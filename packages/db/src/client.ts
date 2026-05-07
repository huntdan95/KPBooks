import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;
export type DatabaseClient = Sql;

export interface ConnectionOptions {
  url: string;
  /** Max pool size. Cloud Run instances are small; keep low. */
  max?: number;
  /** Timeout for idle connections in seconds. */
  idleTimeout?: number;
}

export function createClient(opts: ConnectionOptions): { sql: Sql; db: Database } {
  const sql = postgres(opts.url, {
    max: opts.max ?? 10,
    idle_timeout: opts.idleTimeout ?? 30,
    prepare: false,
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export { schema };
