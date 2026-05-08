import { customers, invoiceLines, invoices } from '@kpbooks/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CreateInvoiceSchema,
  InvoiceError,
  createInvoice,
  voidInvoice,
} from '../modules/invoices/posting.service.js';

const ListQuery = z.object({
  status: z.enum(['open', 'partial', 'paid', 'void']).optional(),
  customerId: z.string().uuid().optional(),
});

const VoidBody = z
  .object({
    voidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
    memo: z.string().max(500).optional(),
  })
  .strict();

export const invoicesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/invoices', async (req) => {
    const q = ListQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await tx
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          invoiceDate: invoices.invoiceDate,
          dueDate: invoices.dueDate,
          status: invoices.status,
          memo: invoices.memo,
          subtotal: invoices.subtotal,
          taxAmount: invoices.taxAmount,
          total: invoices.total,
          balanceDue: invoices.balanceDue,
          customerId: invoices.customerId,
          customerName: customers.displayName,
          postedJournalEntryId: invoices.postedJournalEntryId,
          voidedJournalEntryId: invoices.voidedJournalEntryId,
          voidedAt: invoices.voidedAt,
          createdAt: invoices.createdAt,
        })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(
          and(
            q.status === undefined ? undefined : eq(invoices.status, q.status),
            q.customerId === undefined ? undefined : eq(invoices.customerId, q.customerId),
          ),
        )
        .orderBy(desc(invoices.invoiceDate), desc(invoices.createdAt));
      return { invoices: rows };
    });
  });

  app.post('/invoices', async (req, reply) => {
    const body = CreateInvoiceSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        createInvoice(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof InvoiceError) {
        const status = err.code === 'duplicate_number' ? 409 : 422;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/invoices/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const [head] = await tx
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          invoiceDate: invoices.invoiceDate,
          dueDate: invoices.dueDate,
          status: invoices.status,
          memo: invoices.memo,
          subtotal: invoices.subtotal,
          taxAmount: invoices.taxAmount,
          total: invoices.total,
          balanceDue: invoices.balanceDue,
          termsDays: invoices.termsDays,
          customerId: invoices.customerId,
          customerName: customers.displayName,
          customerEmail: customers.email,
          postedJournalEntryId: invoices.postedJournalEntryId,
          voidedJournalEntryId: invoices.voidedJournalEntryId,
          voidedAt: invoices.voidedAt,
          createdAt: invoices.createdAt,
          updatedAt: invoices.updatedAt,
        })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(eq(invoices.id, id));
      if (!head) return reply.status(404).send({ error: 'not_found' });

      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, id))
        .orderBy(asc(invoiceLines.lineNumber));

      return { ...head, lines };
    });
  });

  app.post('/invoices/:id/void', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = VoidBody.parse(req.body ?? {});
    const today = new Date().toISOString().slice(0, 10);
    try {
      const result = await req.withTenantTx(async (tx) =>
        voidInvoice(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
          { voidDate: body.voidDate ?? today, memo: body.memo },
        ),
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof InvoiceError) {
        const status =
          err.code === 'not_found' ? 404 : err.code === 'already_voided' ? 409 : 422;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
