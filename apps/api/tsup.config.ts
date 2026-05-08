import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: 'esm',
  target: 'node20',
  clean: true,
  sourcemap: true,
  // Bundle the workspace packages (@kpbooks/db, @kpbooks/money) into the
  // output. Without this, tsup marks them external (because they're listed
  // in `dependencies`), then at runtime Node tries to load
  // packages/db/src/index.ts as JS and crashes — that's why the Cloud Run
  // container exited before binding $PORT.
  //
  // npm deps (fastify, drizzle-orm, postgres, firebase-admin, etc.) remain
  // external and are loaded from node_modules at runtime.
  noExternal: [/^@kpbooks\//],
});
