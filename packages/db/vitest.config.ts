import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Integration tests share a Postgres connection; serialize file execution.
    fileParallelism: false,
    // Each test creates its own company so within-file parallelism is safe.
  },
});
