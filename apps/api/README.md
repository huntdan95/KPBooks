# @kpbooks/api

Fastify API for KPBooks. Runs on Cloud Run in production; locally via `pnpm dev`.

## Quick start

```bash
cp .env.example .env
# edit .env, set GOOGLE_APPLICATION_CREDENTIALS to your downloaded service-account JSON
pnpm install
pnpm db:up                   # local Postgres
pnpm --filter @kpbooks/db generate
pnpm db:migrate
pnpm --filter @kpbooks/api dev
```

## Request flow

1. Client sends `Authorization: Bearer <Firebase ID token>` and `x-kpbooks-company: <uuid>`.
2. `firebase-auth` plugin verifies the token, mirrors the Firebase user into our `users` table, and resolves the membership/role for the requested company.
3. Route handlers call `req.withTenantTx(...)` which opens a Postgres transaction, calls `set_config('app.current_company', ...)` etc., and runs the callback.
4. The Postgres RLS policies + the deferred ledger balance trigger are the final word on what's visible and what posts.

## Endpoints (Phase 0)

- `GET /v1/healthz` — liveness probe (no auth)
- `GET /v1/readyz` — DB ping (no auth)
- `GET /v1/ledger/accounts` — list COA (auth + company required)
- `POST /v1/ledger/accounts` — create account
- `POST /v1/ledger/journal-entries` — post a journal entry (the only writer)
- `GET /v1/ledger/reports/trial-balance?asOf=YYYY-MM-DD`
- `GET /v1/ledger/reports/pnl?start=YYYY-MM-DD&end=YYYY-MM-DD`
- `GET /v1/ledger/reports/balance-sheet?asOf=YYYY-MM-DD`

## Why the only-writer rule

`posting.service.postEntry()` is the sole code path that inserts into `journal_entries` / `journal_lines`. Invoicing, bills, payments, payroll, bank-feed posting — every future module funnels through it. That keeps the audit guarantees in one place: ≥ 2 lines per entry, debits = credits per currency, account-belongs-to-company check, and the closed-period guard.

To "edit" a posted entry you reverse it (`reverseEntry`) and post a replacement.
