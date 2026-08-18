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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = 'kpbooks-91c48';
const args = new Set(process.argv.slice(2));
const webOnly = args.has('--web-only');
const apiOnly = args.has('--api-only');

// Anchor to the repo root no matter where the script was invoked from —
// firebase.json/.firebaserc resolution and the Cloud Build source upload
// both depend on the cwd.
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

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

// gcloud may be installed but missing from THIS terminal's PATH (a shell
// opened before the SDK install never picks it up). Fall back to the
// standard per-user install location.
function findGcloud() {
  if (have('gcloud')) return 'gcloud';
  const winget = path.join(
    process.env.LOCALAPPDATA ?? '',
    'Google',
    'Cloud SDK',
    'google-cloud-sdk',
    'bin',
    'gcloud.cmd',
  );
  if (existsSync(winget)) return `"${winget}"`;
  return null;
}

// 1. Build everything (includes typecheck via tsc in each package's build).
run('build', 'pnpm', ['build']);

// 2. API via Cloud Build (migrations run inside the pipeline).
if (!webOnly) {
  const gcloud = findGcloud();
  if (gcloud) {
    run('api deploy', gcloud, [
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

// 3. Web via Firebase Hosting. --project pinned explicitly so the deploy
// never depends on .firebaserc resolution or firebase-tools' per-directory
// activeProjects state.
if (!apiOnly) {
  run('web deploy', 'npx', [
    '--no-install',
    'firebase',
    'deploy',
    '--only',
    'hosting',
    '--project',
    PROJECT,
  ]);
}

console.log('\n✔ deploy complete');
