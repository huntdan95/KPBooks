# KPBooks — QuickBooks Desktop parity audit & health check

**Date:** 2026-08-11 · **Baseline:** commit `14323ac` (Slice #34 Phase C) · **Scope:** full codebase audit vs. QuickBooks Desktop Pro/Premier feature set (ACH/direct-deposit payroll excluded by design), plus a working-order verification pass before client presentation.

> **Update (same day, after syncing with origin/main):** this audit ran against a clone that was 14 commits behind — slices #35–47 existed on the remote. Items below that those slices shipped: **fixed assets register + depreciation** (#35), **Sales Tax Liability report** (#36), **1099-MISC PDFs** (#37), **activity log / audit trail** (#38), **cash-flow forecast** (#39), **customer/vendor merge** (#40), **mileage tracking** (#43), **documents repository** (#46), plus UI polish and mobile navigation (#41–45, #47). The remote also carried its own fix for the 0030 enum migration. Treat those rows in the tables below as done pending a coverage re-check; the remaining high-importance gaps (write checks, check printing, payroll liabilities, bank-rec matching, credit memos, GL viewer, report export, role enforcement, opening balances, IIF idempotency, cash basis) are all still open on the synced code.

---

## 1. Health check results

| Check | Result |
|---|---|
| TypeScript (all 4 packages) | ✅ clean (after `pnpm install` restored missing `pdf-lib`) |
| Build (web + API + packages) | ✅ clean |
| `@kpbooks/money` tests | ✅ 12/12 |
| `@kpbooks/api` tests | ✅ 118/118 |
| `@kpbooks/db` tests | ✅ 36/36 — **suite had been broken since the RLS hard-fix** (see §2) |
| Rules-of-Hooks lint (ad hoc) | ✅ clean after 2 fixes (see §2) |
| Deployed web bundle (`kpbooks-91c48.web.app`) | ✅ current with HEAD (contains Slice #34C strings) |
| Deployed API (Cloud Run via `/v1/**` rewrite) | ✅ current routes, healthy, live Neon reachable |
| Live Neon migration state ≥ 0030 | ⚠️ **unverified — check before presenting** (see §3) |

## 2. Bugs found and fixed this session (uncommitted, in working tree)

1. **DB test suite / fresh-environment migrations broken** — `0029_app_user_role.sql` does `GRANT kpbooks_app TO neondb_owner`, which fails on any non-Neon Postgres and aborted every test run at global setup. Fixed by creating a stand-in `neondb_owner` role before migrating (test `global-setup.ts` + a docker-compose initdb script); the applied file itself is untouched, so its recorded hash on Neon stays valid. Also promoted `kpbooks_app` to LOGIN in test setup (0029 creates it NOLOGIN).
2. **`0030_payroll_tracking.sql` can never apply on a fresh DB** — it adds the `subcontractor` enum value and *uses* it in partial-index predicates in the same transaction ("unsafe use of new value"). Fixed with a new `0029a_worker_type_subcontractor.sql` that adds the value in its own transaction; 0030's `ADD VALUE IF NOT EXISTS` then no-ops and the untouched file applies cleanly.
3. **Custom API error handler was dead code** — registered *after* the routes, so every route used Fastify's default handler, leaking raw internals (Zod issues; potentially Postgres errors) on 500s. Moved before route registration in `app.ts`, added a ZodError→400 branch, and hardened the public W-9 endpoints to return a clean 404 on malformed tokens (they returned a 500 with a leaked Zod dump — verified against production).
4. **Two Rules-of-Hooks violations** — the same class that previously blanked pages in prod. `AppShell.tsx` had a `useEffect` below the `!isMember` early return: on **first sign-in from a clean browser** (or picking a company after creating one) the hook count changes between renders → React throws → **white screen**. `App.tsx` called `useAuth` after a conditional return (latent). Both hoisted above the early returns.
5. **Reports date filters were silent no-ops** — Trial Balance, P&L, and Balance Sheet always returned **all-time** figures regardless of the dates picked (predicate sat in an unused LEFT JOIN). Dashboard "MTD" tiles inherited this. Fixed with the CASE-inside-SUM pattern; **verified with 16 assertions against a real migrated Postgres**.
6. **Balance Sheet perpetual "imbalance"** — net income was never rolled into equity (no closing entries exist). Now shows a virtual **Net Income** equity line like QuickBooks; `imbalance` only flags genuine problems.
7. **Cash-basis P&L 500** — the UI offered Cash basis but the API threw an uncaught error. Toggle disabled in UI ("coming soon"), API returns a clean 422.
8. **"1099 Subs" tab dead** — the workers list API rejected `workerType=subcontractor` (enum omission); the tab errored instead of listing subs. One-line fix.
9. **Recurring "Run all due" skipped every open-ended template** — `eq(endDate, endDate)` is SQL NULL for NULL end dates, so monthly retainers with no end date (the normal case) were silently excluded while the button showed them as due. Fixed with `isNull() OR gte()`.
10. **Pay stubs showed gross = net with zero withholdings** — the stub route hardcoded `deductions: []` and never read `payroll_run_lines` (whose whole purpose is the stub). Now joins the run line: gross, FIT/SS/Medicare/SIT/other with YTD columns, net, pay-period dates, and an hours×rate earnings line; subcontractors get the 1099 footnote.

## 3. Pre-presentation checklist

1. **Verify/apply migrations on live Neon** (the 0030 bug above makes it likely the live DB is missing payroll tables → Payroll pages would 500 in the demo):
   - Check: in the Neon console run `SELECT name FROM kpbooks_migrations ORDER BY name;` — you need everything through `0033_payroll_runs_rls.sql`.
   - Apply: `DATABASE_URL="<neon-url from Secret Manager: kpbooks-database-url>" pnpm db:migrate` (safe + idempotent now that 0029a exists).
2. **Review & commit this session's changes** (`git status` shows 9 modified + 2 new files, all described in §2).
3. **Redeploy both halves** — they deploy separately:
   - API: Cloud Build via `cloudbuild.api.yaml`
   - Web: `pnpm --filter @kpbooks/web build` then `firebase deploy --only hosting`
4. **Do a signed-in dry run** of the demo flow (I verified everything except authenticated flows, which require your Google sign-in): Dashboard → Invoices → Reports (check date pickers change numbers) → Payroll run → a pay-stub PDF.
5. **Demo landmines to avoid** (known-inaccurate paths, not yet fixed — details in §5):
   - Don't print a **statement or aging report for a past date** (uses current balances; the aging box can disagree with the closing balance).
   - Don't demo **bank reconciliation against books kept in the payments module** (reconcile only sees CSV-imported lines).
   - Don't re-upload the same **IIF transaction file** (double-posts).
   - Don't lean on the **workers' comp report for W-2 employees** (aggregates net, not gross).

## 4. QuickBooks Desktop gap analysis

Full machine-readable inventory in the session workflow output; distilled here. "Importance" is rated for this practice: 1 CPA + 2 helpers, ~250 small-business clients, contractor-heavy, printed-check payroll.

### High importance

| Gap | Status | Notes |
|---|---|---|
| **Write Checks** (bill-less check/expense entry) | Missing | Every vendor payment requires a posted bill; a quick check to the landlord takes two documents. The workhorse QBD entry for a checks-only office. |
| **Check printing + numbering** | Missing | No check layout, no per-account number sequencing, no batch print; pay-run payments carry no reference. Every client payroll is printed checks. |
| **Payroll liabilities** | Missing | Pay runs post one A/P bill+payment at NET; withholdings are display-only, wage expense understated, 941 deposits untrackable. Requires gross-basis posting (DR gross wages, CR liability accounts, CR net). |
| **Bank reconciliation of booked activity** | Partial | Reconcile sees only CSV-imported rows — payments/payroll/manual JEs hitting the bank never appear, so books kept through the app can't reconcile without double-posting cash. Highest-leverage fix in the product. |
| **Credit memos / refunds / customer credits / write-offs** | Missing | No credit memo doc (negative invoices rejected); receive-payment demands exact application. A/R adjustment is constant CPA work. |
| **Sales tax management** | Partial | Flat single rate works, but no agencies, groups, liability report, or Pay Sales Tax flow. Brittle: liability account found by exact name `Sales Tax Payable`; `taxExempt` flag never enforced. |
| **General Ledger report / JE viewer** | Missing | The ledger is write-only from the UI — no way to list entries, see an account register, or drill into what a void/import posted. The most-used QBD report for a CPA. |
| **Report export (CSV/Excel) + print** | Missing | No report can leave the app; can't hand a P&L to a client or pull TB into tax software. Low effort, immediate payoff. |
| **User management + role enforcement** | Partial | No invite/membership UI (helpers onboarded via manual SQL); roles enforced on only ~2 endpoints, so a "viewer" can post invoices and payroll; `users.disabled` never checked. |
| **Opening balances never post** | Partial | `openingBalance` on customers/vendors is stored/displayed but never reaches ledger, aging, or statements → converted books understate balances. Gates the 250-client migration. |
| **IIF transaction import: idempotency + subledgers** | Partial | Re-upload double-posts everything (no sourceId); imported invoices/bills/payments become bare JEs, so migrated books have empty A/R-A/P subledgers. Also gates migration. |
| **Cash-basis reports** | Missing | Most small clients file cash-basis. Now fails cleanly (422) instead of 500, but the engine (payment-application-driven) is unbuilt. |

### Medium importance

Undeposited funds → Make Deposits · vendor credits · progress invoicing (contractor draws) · estimate **edit UI** (API exists, no form) · sales receipts · statement historical accuracy (balance-forward + as-of aging reconstruction) · receive-payment discounts/write-offs + payment drill-down UI · OFX/QFX bank feeds · transfer leg-matching · recurring: edit UI + scheduled auto-fire (run-all bug fixed) · true employee records (W-4 fields feed nothing) · 941/940/W-2/W-3 prep (all data now exists per run line) · workers' comp gross-basis fix · **Customer:Jobs + job costing** (schema hook `dimension_json` exists, unused) · billable time/expenses → invoices (time flows only to A/P today) · 1099-MISC + configurable threshold ($600 hard-coded; 2026 threshold is $2,000) + card-payment exclusion · budgets + budget-vs-actual · audit trail · per-company backup/export (import exists, export doesn't) · transaction attachments (receipt OCR currently **discards the image** after extraction) · COA hierarchy/balances/merge · classes (per-class P&L) · A/R-A/P aging detail + drill-down · report comparison columns · **fixed assets** · bill detail view (API exists, rows not clickable) · weekly timesheet grid · scheduled-payroll due tracking.

> ~~Shortcut: the unmerged worktree contains fixed assets, activity log, and Documents.~~ **Superseded:** that work shipped on origin/main as slices #35, #38, and #46 — see the update note at the top.

### Low importance (reasonable v1 exclusions)

Inventory (QOH/assemblies/COGS) · purchase orders + item receipts · price levels · named payment terms with discount math · payment methods list · form templates/logo · custom fields · sales orders · finance charges · income tracker/collections · sales-by-item analytics · loan manager · multi-currency (schema ready, USD-only enforced) · accountant's copy (obviated by cloud model) · global search (AI chat partially substitutes) · closing-date password override (trigger GUC exists but unreachable from API).

## 5. Known accuracy caveats (unfixed, be aware)

- **Historical aging/statements**: `arAging(asOf)` uses each invoice's *current* `balance_due`, so any backdated report reflects later payments. Today-dated reports are correct.
- **Statement balance-forward** ignores `customers.openingBalance` (see opening-balances gap).
- **Workers' comp / payroll register basis**: aggregates payments (net for W-2, gross-ish for 1099) and includes non-payroll vendor payments; deactivated workers drop out of history.
- **Voiding a bill built from time entries orphans the hours** (`billed_bill_id` never cleared — entries stay locked, can't re-bill).
- **Estimate rename to duplicate number** returns raw 500 (now a clean 400 after the error-handler fix, but not a 409).
- Stale doc comments in `invoices/posting.service.ts` ("tax not yet supported") contradict the code.

## 6. Strengths over QuickBooks Desktop (demo talking points)

- **AI bank-statement auto-categorization** with per-suggestion confidence + reasoning; **bank rules** more expressive than QBD renaming rules.
- **Receipt OCR** → prefilled bill from a photo.
- **"Chat with your books"** — 11 read-only RLS-scoped tools; ad-hoc answers QBD needs manual report-building for.
- **Tokenized W-9 collection** (single-use, 30-day public links; bulk-request everyone paid ≥$600 without a W-9) — QBD has nothing; killer feature for a 1099-heavy practice.
- **1099-NEC in-app**: preflight blockers/warnings + multi-copy PDFs — QBD pushes you to a paid e-file service.
- **Subcontractor compliance**: license/GL/WC insurance + lien-waiver tracking with expiry dashboard — beyond QBD entirely.
- **True multi-company**: one login, instant switching across ~250 clients, per-company Postgres RLS isolation vs. QBD's one-file-at-a-time.
- **Ledger integrity**: append-only journal, DB-enforced balancing/closed-period/locked-entry triggers, voids as explicit reversal pairs — stronger than QBD's editable transactions.
- **Time-entries → A/P bills** pipeline for paying subs from logged hours (QBD timesheets can't do this).
- Cloud, Google SSO, all three staff concurrent, ~zero hosting cost, no license/upgrade treadmill.
