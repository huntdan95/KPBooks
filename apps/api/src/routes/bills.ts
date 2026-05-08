import { billLines, bills, vendors } from '@kpbooks/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BillError, CreateBillSchema, createBill, voidBill } from '../modules/bills/posting.service.js';

const ListQuery = z.object({
  status: z.enum(['open', 'partial', 'paid', 'void']).optional(),
  vendorId: z.string().uuid().optional(),
});

const VoidBody = z
  .object({
    voidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
    memo: z.string().max(500).optional(),
  })
  .strict();

export const billsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/bills', async (req) => {
    const q = ListQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await tx
        .select({
          id: bills.id,
          billNumber: bills.billNumber,
          billDate: bills.billDate,
          dueDate: bills.dueDate,
          status: bills.status,
          memo: bills.memo,
          subtotal: bills.subtotal,
          taxAmount: bills.taxAmount,
          total: bills.total,
          balanceDue: bills.balanceDue,
          vendorId: bills.vendorId,
          vendorName: vendors.displayName,
          postedJournalEntryId: bills.postedJournalEntryId,
          voidedJournalEntryId: bills.voidedJournalEntryId,
          voidedAt: bills.voidedAt,
          createdAt: bills.createdAt,
        })
        .from(bills)
        .innerJoin(vendors, eq(vendors.id, bills.vendorId))
        .where(
          and(
            q.status === undefined ? undefined : eq(bills.status, q.status),
            q.vendorId === undefined ? undefined : eq(bills.vendorId, q.vendorId),
          ),
        )
        .orderBy(desc(bills.billDate), desc(bills.createdAt));
      return { bills: rows };
    });
  });

  app.post('/bills', async (req, reply) => {
    const body = CreateBillSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        createBill(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof BillError) {
        const status = err.code === 'duplicate_number' ? 409 : 422;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/bills/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const [head] = await tx
        .select({
          id: bills.id,
          billNumber: bills.billNumber,
          billDate: bills.billDate,
          dueDate: bills.dueDate,
          status: bills.status,
          memo: bills.memo,
          subtotal: bills.subtotal,
          taxAmount: bills.taxAmount,
          total: bills.total,
          balanceDue: bills.balanceDue,
          termsDays: bills.termsDays,
          vendorId: bills.vendorId,
          vendorName: vendors.displayName,
          vendorEmail: vendors.email,
          postedJournalEntryId: bills.postedJournalEntryId,
          voidedJournalEntryId: bills.voidedJournalEntryId,
          voidedAt: bills.voidedAt,
          createdAt: bills.createdAt,
          updatedAt: bills.updatedAt,
        })
        .from(bills)
        .innerJoin(vendors, eq(vendors.id, bills.vendorId))
        .where(eq(bills.id, id));
      if (!head) return reply.status(404).send({ error: 'not_found' });

      const lines = await tx
        .select()
        .from(billLines)
        .where(eq(billLines.billId, id))
        .orderBy(asc(billLines.lineNumber));

      return { ...head, lines };
    });
  });

  app.post('/bills/:id/void', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = VoidBody.parse(req.body ?? {});
    const today = new Date().toISOString().slice(0, 10);
    try {
      const result = await req.withTenantTx(async (tx) =>
        voidBill(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
          { voidDate: body.voidDate ?? today, memo: body.memo },
        ),
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof BillError) {
        const status =
          err.code === 'not_found' ? 404 : err.code === 'already_voided' ? 409 : 422;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
