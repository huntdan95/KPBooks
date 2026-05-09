import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { renderCustomerStatement } from '../modules/forms/customer-statement.js';
import {
  StatementError,
  buildStatementData,
  listBulkStatementCandidates,
} from '../modules/statements/statements.service.js';

const Date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const errStatus = (code: StatementError['code']): number => {
  switch (code) {
    case 'not_found':
      return 404;
    default:
      return 422;
  }
};

export const statementsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  /**
   * GET /v1/customers/:id/statement.pdf?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD
   * Streams a printable A/R statement.
   */
  app.get('/customers/:id/statement.pdf', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { periodStart, periodEnd, asOf } = z
      .object({ periodStart: Date, periodEnd: Date, asOf: Date.optional() })
      .parse(req.query);

    return req.withTenantTx(async (tx) => {
      try {
        const data = await buildStatementData(
          tx,
          req.auth!.companyId!,
          id,
          periodStart,
          periodEnd,
          asOf,
        );
        const pdf = await renderCustomerStatement(data);
        const safeName = `${data.customer.name.replace(/[^A-Za-z0-9]+/g, '_')}_Statement_${periodEnd}.pdf`;
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
        reply.header('Content-Length', String(pdf.length));
        return reply.send(pdf);
      } catch (err) {
        if (err instanceof StatementError) {
          return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    });
  });

  /**
   * GET /v1/statements/candidates?periodStart=&periodEnd=
   *   Returns the list of customers eligible for a statement (non-zero
   *   activity in the period or non-zero balance). Used by the bulk panel
   *   on the Customers list to preview targets before downloading.
   */
  app.get('/statements/candidates', async (req) => {
    const { periodStart, periodEnd } = z
      .object({ periodStart: Date, periodEnd: Date })
      .parse(req.query);
    return req.withTenantTx(async (tx) => {
      const candidates = await listBulkStatementCandidates(tx, periodStart, periodEnd);
      return { periodStart, periodEnd, candidates };
    });
  });
};
