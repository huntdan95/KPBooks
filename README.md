# KPBooks

Self-hosted bookkeeping/accounting platform — replacing QuickBooks Desktop with a clean-room competitor on Firebase + GCP, with AI assists from Claude.

> Phase 0 scaffold. Ledger spine + Firebase Auth + Cloud Run API skeleton + React/Vite web shell. Invoicing, banking, payroll, and AI features land in subsequent phases per the [plan](https://github.com/huntdan95/KPBooks).

## Repo layout

```
apps/
  api/          Fastify on Cloud Run — the only service that talks to Postgres
  web/          React + Vite + TanStack Router — Firebase-Hosted SPA
packages/
  db/           Drizzle schema + RLS + deferred ledger trigger migration
  money/        Decimal.js wrapper. Never use raw `number` for money.
infra/
  terraform/    GCP project resources (Cloud SQL, Artifact Registry, IAM, secrets)
```

## Local dev

Prereqs: Node 20, pnpm 9, Docker Desktop, gcloud CLI, Firebase CLI.

```bash
# Install everything
pnpm install

# Local Postgres
pnpm db:up

# Generate Drizzle migration from current schema, then apply
pnpm --filter @kpbooks/db generate
pnpm db:migrate     # applies generated 0000_* and the hand-written 0001_init_rls.sql

# Start API + Web in parallel
pnpm dev
# API:  http://localhost:8080  (health: /v1/healthz)
# Web:  http://localhost:5173
```

You'll need a Firebase Admin service-account JSON for local API runs. Download from
GCP Console → IAM & Admin → Service Accounts → `kpbooks-api@...iam.gserviceaccount.com` → Keys, save somewhere outside the repo, and set `GOOGLE_APPLICATION_CREDENTIALS` in `apps/api/.env`.

## Cloud deploy (after Terraform apply)

```bash
cd infra/terraform
terraform apply -var="project_id=kpbooks-91c48"
```

Then push to `main` and Cloud Build runs `cloudbuild.yaml` — typecheck, test, build the API container, deploy to Cloud Run, build the web bundle, deploy to Firebase Hosting.

## The accounting spine — what's non-negotiable

- **Money is `NUMERIC(19,4)` in Postgres and `Decimal.js` in TS.** No `number`. No `float`. The CI lint rule rejects `number` types on monetary fields.
- **Every economic event is one balanced journal entry.** The DB trigger `journal_lines_balanced_trg` is `DEFERRABLE INITIALLY DEFERRED` — it fires at COMMIT, so unbalanced posts never make it to disk.
- **Multi-company isolation is RLS, not app code.** Every domain table has a `company_id`; every request runs in a transaction that `SET LOCAL app.current_company = <uuid>`. Forget the GUC and the query returns 0 rows — fail-closed.
- **Posted entries are append-only.** Edits produce a reversing entry plus a replacement, both linked. The `ledger_block_locked_*` triggers refuse to mutate locked entries.
- **The only writer is `apps/api/src/modules/ledger/posting.service.ts:postEntry`.** Invoicing, bills, payments, payroll — every future module funnels through it. Don't let anything else reach `journal_entries`.

## What's wired up

- ✅ Drizzle schema for companies, users, memberships, accounts, journal_entries, journal_lines
- ✅ RLS + deferred balance trigger + closed-period guard + locked-entry guard
- ✅ Money type with banker rounding + balance helper
- ✅ Posting service (the sole writer)
- ✅ Trial balance / P&L / Balance sheet endpoints
- ✅ Firebase Auth verification on the API
- ✅ Cloud Run Dockerfile + Cloud Build pipeline
- ✅ Firebase Hosting + SPA routing config
- ✅ Terraform skeleton for Cloud SQL, IAM, Secret Manager, Artifact Registry

## What's next (Phase 0 → 1 transition)

- Drizzle migration generation + first end-to-end test of a posted JE
- Login + company-switcher UI in `apps/web`
- Customer/vendor schema + invoice/bill posting (Phase 1 kickoff)
- IIF importer (so we can pull QuickBooks data in)

See the full plan in `~/.claude/plans/my-friends-have-an-graceful-bengio.md` (local) or the project docs for phased scope.

## License

Private — © KPBooks. Not for redistribution.
