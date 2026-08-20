import { accounts } from '@kpbooks/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PostingError, postEntry, postingSchemas } from '../modules/ledger/posting.service.js';
import {
  ACCOUNT_DETAIL_MAX_PAGE_SIZE,
  ACCOUNT_DETAIL_PAGE_SIZE,
  GENERAL_LEDGER_MAX_ROW_CAP,
  GENERAL_LEDGER_ROW_CAP,
  accountDetail,
  apAging,
  arAging,
  balanceSheet,
  cashFlowForecast,
  complianceExpiring,
  generalLedger,
  nineteenNinetyNineSummary,
  payrollRegister,
  profitAndLoss,
  salesTaxLiability,
  statementOfCashFlows,
  trialBalance,
  workersCompSummary,
} from '../modules/ledger/reports.service.js';

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const ListAccountsQuery = z.object({
  active: z.enum(['true', 'false']).optional(),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']).optional(),
});

const CreateAccount = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  subtype: z.string().min(1),
  parentId: z.string().uuid().optional(),
  currency: z.string().min(3).max(8).default('USD'),
  description: z.string().max(500).optional(),
});

// PATCH only allows safe-to-change fields. type/subtype/parentId/companyId are
// structural and changing them would invalidate posted journal lines, so we
// reject those at the API layer rather than at the DB. Use a new account if
// you need a different category.
const UpdateAccount = z
  .object({
    code: z.string().min(1).max(40).optional(),
    name: z.string().min(1).max(120).optional(),
    currency: z.string().min(3).max(8).optional(),
    description: z.string().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const ledgerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/ledger/accounts', async (req) => {
    const q = ListAccountsQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await tx
        .select()
        .from(accounts)
        .where(
          and(
            q.active === undefined ? undefined : eq(accounts.isActive, q.active === 'true'),
            q.type === undefined ? undefined : eq(accounts.type, q.type),
          ),
        );
      return { accounts: rows };
    });
  });

  app.post('/ledger/accounts', async (req, reply) => {
    const body = CreateAccount.parse(req.body);
    return req.withTenantTx(async (tx) => {
      const [created] = await tx
        .insert(accounts)
        .values({
          companyId: req.auth!.companyId!,
          code: body.code,
          name: body.name,
          type: body.type,
          subtype: body.subtype as never,
          parentId: body.parentId ?? null,
          currency: body.currency,
          description: body.description ?? null,
        })
        .returning();
      return reply.status(201).send(created);
    });
  });

  app.patch('/ledger/accounts/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateAccount.parse(req.body);
    return req.withTenantTx(async (tx) => {
      const update: Record<string, unknown> = {};
      if (body.code !== undefined) update.code = body.code;
      if (body.name !== undefined) update.name = body.name;
      if (body.currency !== undefined) update.currency = body.currency;
      if (body.description !== undefined) update.description = body.description;
      if (body.isActive !== undefined) update.isActive = body.isActive;

      if (Object.keys(update).length === 0) {
        const [row] = await tx.select().from(accounts).where(eq(accounts.id, id));
        if (!row) return reply.status(404).send({ error: 'not_found' });
        return row;
      }

      const [updated] = await tx
        .update(accounts)
        .set(update)
        .where(eq(accounts.id, id))
        .returning();
      if (!updated) return reply.status(404).send({ error: 'not_found' });
      return updated;
    });
  });

  app.post('/ledger/journal-entries', async (req, reply) => {
    const body = postingSchemas.PostEntrySchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        postEntry(tx, { companyId: req.auth!.companyId!, userId: req.auth!.userId }, body),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof PostingError) {
        return reply.status(422).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/ledger/reports/trial-balance', async (req) => {
    const { asOf } = z.object({ asOf: DateOnly }).parse(req.query);
    return req.withTenantTx(async (tx) => ({ asOf, rows: await trialBalance(tx, asOf) }));
  });

  app.get('/ledger/reports/pnl', async (req) => {
    const { start, end, basis } = z
      .object({
        start: DateOnly,
        end: DateOnly,
        basis: z.enum(['accrual', 'cash']).default('accrual'),
      })
      .parse(req.query);
    return req.withTenantTx(async (tx) => profitAndLoss(tx, start, end, basis));
  });

  /**
   * General ledger drill-down. Every posted line in [start, end] grouped by
   * account, in date order, with an opening balance (all activity strictly
   * before `start`) and a running balance down the rows.
   *
   * `limit` caps DETAIL ROWS ACROSS ALL ACCOUNTS COMBINED (default 5,000, hard
   * max 20,000). Opening/closing balances, period debit/credit totals and
   * rowCount are computed over the full range whatever the cap does, so a
   * capped response never mis-states money -- it just returns fewer rows and
   * says so via `truncated` on the report and on each shortened account group.
   * Page through one busy account with /ledger/reports/account-detail.
   */
  app.get('/ledger/reports/general-ledger', async (req) => {
    const { start, end, accountId, limit } = z
      .object({
        start: DateOnly,
        end: DateOnly,
        accountId: z.string().uuid().optional(),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(GENERAL_LEDGER_MAX_ROW_CAP)
          .default(GENERAL_LEDGER_ROW_CAP),
      })
      .parse(req.query);
    return req.withTenantTx(async (tx) =>
      generalLedger(tx, start, end, { accountId, rowCap: limit }),
    );
  });

  /**
   * Single-account detail -- what powers 'click a P&L number and see what's in
   * it'. Offset-paginated (default 500 rows, hard max 5,000) with the running
   * balance carried across pages, so page 2 opens where page 1 closed.
   * `truncated` means this page is not the whole range; `hasMore` means more
   * rows follow -- refetch with offset += limit. 404 when the account does not
   * exist for this tenant.
   */
  app.get('/ledger/reports/account-detail', async (req, reply) => {
    const { accountId, start, end, limit, offset } = z
      .object({
        accountId: z.string().uuid(),
        start: DateOnly,
        end: DateOnly,
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(ACCOUNT_DETAIL_MAX_PAGE_SIZE)
          .default(ACCOUNT_DETAIL_PAGE_SIZE),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const report = await req.withTenantTx(async (tx) =>
      accountDetail(tx, accountId, start, end, { limit, offset }),
    );
    if (!report) return reply.status(404).send({ error: 'not_found' });
    return report;
  });
  app.get('/ledger/reports/balance-sheet', async (req) => {
    const { asOf } = z.object({ asOf: DateOnly }).parse(req.query);
    return req.withTenantTx(async (tx) => balanceSheet(tx, asOf));
  });

  app.get('/ledger/reports/statement-of-cash-flows', async (req) => {
    const { start, end } = z.object({ start: DateOnly, end: DateOnly }).parse(req.query);
    return req.withTenantTx(async (tx) => statementOfCashFlows(tx, start, end));
  });

  app.get('/ledger/reports/ar-aging', async (req) => {
    const { asOf } = z.object({ asOf: DateOnly }).parse(req.query);
    return req.withTenantTx(async (tx) => arAging(tx, asOf));
  });

  app.get('/ledger/reports/ap-aging', async (req) => {
    const { asOf } = z.object({ asOf: DateOnly }).parse(req.query);
    return req.withTenantTx(async (tx) => apAging(tx, asOf));
  });

  app.get('/ledger/reports/payroll-register', async (req) => {
    const { from, to, workerType } = z
      .object({
        from: DateOnly,
        to: DateOnly,
        workerType: z.enum(['contractor', 'employee', 'subcontractor']).optional(),
      })
      .parse(req.query);
    return req.withTenantTx(async (tx) => payrollRegister(tx, from, to, workerType));
  });

  app.get('/ledger/reports/workers-comp-summary', async (req) => {
    const { from, to } = z.object({ from: DateOnly, to: DateOnly }).parse(req.query);
    return req.withTenantTx(async (tx) => workersCompSummary(tx, from, to));
  });

  app.get('/ledger/reports/compliance-expiring', async (req) => {
    const { withinDays } = z
      .object({ withinDays: z.coerce.number().int().min(0).max(365).default(30) })
      .parse(req.query);
    return req.withTenantTx(async (tx) => ({
      withinDays,
      rows: await complianceExpiring(tx, withinDays),
    }));
  });

  app.get('/ledger/reports/sales-tax-liability', async (req) => {
    const { from, to } = z.object({ from: DateOnly, to: DateOnly }).parse(req.query);
    return req.withTenantTx(async (tx) => salesTaxLiability(tx, from, to));
  });

  app.get('/ledger/reports/cash-flow-forecast', async (req) => {
    const { asOf, horizonDays } = z
      .object({
        asOf: DateOnly,
        horizonDays: z.coerce.number().int().min(7).max(365).default(90),
      })
      .parse(req.query);
    return req.withTenantTx(async (tx) => cashFlowForecast(tx, asOf, horizonDays));
  });

  app.get('/ledger/reports/1099-summary', async (req) => {
    const { year } = z
      .object({
        year: z.coerce
          .number()
          .int()
          .min(2000)
          .max(2100),
      })
      .parse(req.query);
    return req.withTenantTx(async (tx) => nineteenNinetyNineSummary(tx, year));
  });
};
