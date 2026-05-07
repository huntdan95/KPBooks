/**
 * Vitest setup: spin up a single Postgres connection for the whole run, and
 * fail fast if DATABASE_URL isn't reachable. Each test creates its own company
 * (RLS isolates them) so we can run the suite in parallel without leaking.
 */
import { afterAll, beforeAll } from 'vitest';
import postgres, { type Sql, type TransactionSql } from 'postgres';

let _sql: Sql | null = null;
let _adminSql: Sql | null = null;

/** App-role connection: NOSUPERUSER NOBYPASSRLS, used for the actual ledger operations. */
export function getSql(): Sql {
  if (!_sql) throw new Error('test setup did not initialise sql');
  return _sql;
}

/** Superuser admin connection: bypasses RLS. Use only for fixture setup/teardown. */
export function getAdminSql(): Sql {
  if (!_adminSql) throw new Error('test setup did not initialise admin sql');
  return _adminSql;
}

/**
 * Drop a test company plus all dependent data, bypassing user triggers
 * (locked-entry guard, etc.) so we don't have to unwind the audit barriers
 * just to clean up. Mirrors what a `pg_restore`-style admin operation does.
 */
export async function dropTestCompany(companyId: string): Promise<void> {
  const sql = getAdminSql();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM companies WHERE id = ${companyId}`;
  });
}

export let dbAvailable = false;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? url;
  if (!url) {
    console.warn(
      '\n  DATABASE_URL not set — db integration tests will skip.' +
        '\n  Run `pnpm db:up` and `pnpm db:migrate` to enable them.\n',
    );
    return;
  }
  _sql = postgres(url, { max: 5, prepare: false });
  _adminSql = postgres(adminUrl, { max: 2, prepare: false });
  dbAvailable = true;

  try {
    await _sql`SELECT 1 FROM kpbooks_migrations LIMIT 1`;
  } catch {
    throw new Error(
      'kpbooks_migrations table missing — run `pnpm --filter @kpbooks/db migrate` first.',
    );
  }
});

afterAll(async () => {
  if (_sql) await _sql.end({ timeout: 5 });
  if (_adminSql) await _adminSql.end({ timeout: 5 });
});

/**
 * Create a fresh company + admin user + simple chart-of-accounts for a single
 * test. Returns the IDs you'll need to set the RLS GUCs.
 */
export interface TestFixture {
  companyId: string;
  userId: string;
  cashAccountId: string;
  revenueAccountId: string;
  expenseAccountId: string;
}

export async function createTestCompany(label: string): Promise<TestFixture> {
  // Fixture setup uses the admin connection: company creation is a platform-
  // level operation that legitimately bypasses tenant RLS (analogous to a
  // service-account endpoint in production).
  const sql = getAdminSql();
  const suffix = `${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  const [company] = await sql<{ id: string }[]>`
    INSERT INTO companies (name) VALUES (${'Test ' + suffix}) RETURNING id
  `;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (firebase_uid, email)
    VALUES (${'firebase_' + suffix}, ${suffix + '@example.com'}) RETURNING id
  `;
  await sql`
    INSERT INTO memberships (user_id, company_id, role)
    VALUES (${user!.id}, ${company!.id}, 'owner')
  `;

  const [cash] = await sql<{ id: string }[]>`
    INSERT INTO accounts (company_id, code, name, type, subtype)
    VALUES (${company!.id}, '1000', 'Cash', 'asset', 'bank') RETURNING id
  `;
  const [revenue] = await sql<{ id: string }[]>`
    INSERT INTO accounts (company_id, code, name, type, subtype)
    VALUES (${company!.id}, '4000', 'Sales', 'revenue', 'income') RETURNING id
  `;
  const [expense] = await sql<{ id: string }[]>`
    INSERT INTO accounts (company_id, code, name, type, subtype)
    VALUES (${company!.id}, '5000', 'Office', 'expense', 'expense') RETURNING id
  `;

  return {
    companyId: company!.id,
    userId: user!.id,
    cashAccountId: cash!.id,
    revenueAccountId: revenue!.id,
    expenseAccountId: expense!.id,
  };
}

/**
 * Run a callback inside a Postgres transaction with the RLS GUCs set, mirroring
 * what the API plugin does in production. Bypasses RLS for setup queries by
 * using the postgres-js `unsafe` escape hatch is NOT what we do — that defeats
 * the point of these tests. Use the sql tag and let the policies fire.
 */
export async function withCompanyTx<T>(
  fixture: Pick<TestFixture, 'companyId' | 'userId'>,
  role: 'owner' | 'admin' | 'bookkeeper' | 'viewer',
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const sql = getSql();
  // postgres-js's `begin` unwraps promise-array results; cast to T because we
  // never return an array of promises from `fn`.
  const result = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_company', ${fixture.companyId}, true)`;
    await tx`SELECT set_config('app.current_user', ${fixture.userId}, true)`;
    await tx`SELECT set_config('app.current_role', ${role}, true)`;
    return fn(tx);
  });
  return result as T;
}
