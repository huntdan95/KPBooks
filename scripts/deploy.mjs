#!/usr/bin/env node
/**
 * One-command production deploy: `pnpm deploy` (or `node scripts/deploy.mjs`).
 *
 *   1. Build every workspace package (fails fast on typecheck/build errors).
 *   2. API: `gcloud builds submit` with cloudbuild.api.yaml — the pipeline
 *      applies DB migrations (from Secret Manager's DATABASE_URL) BEFORE
 *      swapping the Cloud Run revision, so a failed migrate leaves the old
 *      API serving.
 *   3. Web: `firebase deploy --only hosting` from apps/web/dist.
 *
 * Flags:
 *   --web-only    skip the API build+migrate (fast path for UI-only changes)
 *   --api-only    skip the hosting deploy
 *
 * Requirements: firebase CLI logged in (web), gcloud CLI logged in (API).
 * If gcloud is missing the script still deploys the web and prints exactly
 * what to run for the API from a machine that has it.
 */
import { spawnSync } from 'node:child_process';

const PROJECT = 'kpbooks-91c48';
const args = new Set(process.argv.slice(2));
const webOnly = args.has('--web-only');
const apiOnly = args.has('--api-only');

const run = (label, cmd, cmdArgs, opts = {}) => {
  console.log(`\n▶ ${label}: ${cmd} ${cmdArgs.join(' ')}`);
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: true, ...opts });
  if (res.status !== 0) {
    console.error(`✖ ${label} failed (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
};

const have = (cmd) =>
  spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: true }).status === 0;

// 1. Build everything (includes typecheck via tsc in each package's build).
run('build', 'pnpm', ['build']);

// 2. API via Cloud Build (migrations run inside the pipeline).
if (!webOnly) {
  if (have('gcloud')) {
    run('api deploy', 'gcloud', [
      'builds',
      'submit',
      `--project=${PROJECT}`,
      '--config=cloudbuild.api.yaml',
      '.',
    ]);
  } else {
    console.warn(
      '\n⚠ gcloud CLI not found — skipping the API deploy.\n' +
        '  From a machine with gcloud (or after installing the Google Cloud SDK\n' +
        '  and running `gcloud auth login`), run:\n\n' +
        `    gcloud builds submit --project=${PROJECT} --config=cloudbuild.api.yaml .\n`,
    );
    if (apiOnly) process.exit(1);
  }
}

// 3. Web via Firebase Hosting.
if (!apiOnly) {
  run('web deploy', 'npx', ['--no-install', 'firebase', 'deploy', '--only', 'hosting']);
}

console.log('\n✔ deploy complete');
