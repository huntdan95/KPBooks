/**
 * Custom migrate runner.
 *
 * Why not drizzle-kit migrate? Drizzle's runner only applies SQL files listed
 * in `migrations/meta/_journal.json` — it would skip our hand-written
 * `0001_init_rls.sql` (the file with the RLS policies, GUC plumbing, and the
 * deferred ledger balance trigger). We need every `*.sql` file in
 * `migrations/` applied in lexicographic order.
 *
 * Track applied migrations in `kpbooks_migrations(name, hash, applied_at)`
 * so re-runs are idempotent and re-issuing a file that's already applied
 * is rejected if its hash changed (catches accidental edits to applied SQL).
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, prepare: false });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS kpbooks_migrations (
        name TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.sql'))
      .map((e) => e.name)
      .sort();

    if (files.length === 0) {
      console.log('no migration files found');
      return;
    }

    const applied = await sql<{ name: string; hash: string }[]>`
      SELECT name, hash FROM kpbooks_migrations
    `;
    const appliedByName = new Map(applied.map((r) => [r.name, r.hash]));

    let appliedCount = 0;
    for (const file of files) {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const body = await readFile(fullPath, 'utf8');
      const hash = createHash('sha256').update(body).digest('hex');

      const prior = appliedByName.get(file);
      if (prior) {
        if (prior !== hash) {
          throw new Error(
            `migration ${file} was previously applied with a different hash. ` +
              `Don't edit applied migrations — write a new one.`,
          );
        }
        continue;
      }

      console.log(`applying ${file}...`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`
          INSERT INTO kpbooks_migrations (name, hash) VALUES (${file}, ${hash})
        `;
      });
      appliedCount++;
      console.log(`  ✓ ${file}`);
    }

    if (appliedCount === 0) {
      console.log('all migrations already applied — nothing to do');
    } else {
      console.log(`applied ${appliedCount} migration(s)`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
