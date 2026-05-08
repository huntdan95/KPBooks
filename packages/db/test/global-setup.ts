/**
 * Vitest globalSetup — boots a real Postgres for the whole test run.
 *
 * Two paths:
 *   1. If DATABASE_URL is already set (e.g. docker-compose Postgres), use it.
 *   2. Otherwise, start an `embedded-postgres` instance, run migrations, and
 *      export DATABASE_URL so the test files can pick it up via process.env.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, '..');
const MIGRATE_SCRIPT = path.join(PKG_DIR, 'scripts', 'migrate.ts');

let pg: EmbeddedPostgres | null = null;
let dataDir: string | null = null;
let providedUrl = false;

export async function setup(): Promise<void> {
  if (process.env.DATABASE_URL) {
    providedUrl = true;
    console.log('using DATABASE_URL from environment:', maskUrl(process.env.DATABASE_URL));
    return;
  }

  dataDir = mkdtempSync(path.join(tmpdir(), 'kpbooks-pg-'));
  const port = 54329; // unlikely to clash with a system Postgres
  const password = 'kpbooks_test';

  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'kpbooks',
    password,
    port,
    persistent: false,
  });

  console.log('initialising embedded-postgres in', dataDir, '— first run downloads the binary');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('kpbooks');

  const adminUrl = `postgres://kpbooks:${password}@127.0.0.1:${port}/kpbooks`;
  process.env.DATABASE_URL = adminUrl;
  console.log('embedded-postgres ready on port', port);

  // Apply migrations as the bootstrap superuser. DDL must run with elevated
  // privileges; the app role exists for runtime queries only.
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', MIGRATE_SCRIPT],
    { cwd: PKG_DIR, env: process.env, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`migrate failed with exit code ${result.status}`);
  }

  // Create a non-superuser application role. In production the app never
  // connects as a superuser; mirror that here so RLS actually fires against
  // the test workload (superusers bypass RLS unconditionally).
  const appPassword = 'kpbooks_app';
  const adminSql = postgres(adminUrl, { max: 1, prepare: false });
  try {
    await adminSql.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpbooks_app') THEN
          CREATE ROLE kpbooks_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $$;

      GRANT USAGE ON SCHEMA public TO kpbooks_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kpbooks_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kpbooks_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kpbooks_app;
    `);
  } finally {
    await adminSql.end({ timeout: 5 });
  }

  // Switch DATABASE_URL to the app role for tests, but expose the admin URL
  // for fixtures that need to bypass RLS (e.g. company/user creation).
  const appUrl = `postgres://kpbooks_app:${appPassword}@127.0.0.1:${port}/kpbooks`;
  process.env.DATABASE_URL = appUrl;
  process.env.ADMIN_DATABASE_URL = adminUrl;
}

export async function teardown(): Promise<void> {
  if (providedUrl) return;
  if (pg) {
    try {
      await pg.stop();
    } catch (err) {
      console.warn('embedded-postgres stop failed:', err);
    }
  }
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function maskUrl(u: string): string {
  return u.replace(/:[^:@/]+@/, ':***@');
}
