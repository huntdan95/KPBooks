import { customers, paymentApplications, payments, vendors } from '@kpbooks/db';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CreatePaymentSchema,
  PaymentError,
  createPayment,
  voidPayment,
} from '../modules/payments/posting.service.js';

const ListQuery = z.object({
  type: z.enum(['customer_received', 'vendor_sent']).optional(),
  customerId: z.string().uuid().optional(),
  vendorId: z.string().uuid().optional(),
  status: z.enum(['posted', 'void']).optional(),
});

const VoidBody = z
  .object({
    voidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
    memo: z.string().max(500).optional(),
  })
  .strict();

export const paymentsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/payments', async (req) => {
    const q = ListQuery.parse(req.query);
    return req.withTenantTx(async (tx) => {
      const rows = await tx
        .select({
          id: payments.id,
          paymentType: payments.paymentType,
          paymentDate: payments.paymentDate,
          paymentMethod: payments.paymentMethod,
          reference: payments.reference,
          amount: payments.amount,
          status: payments.status,
          memo: payments.memo,
          customerId: payments.customerId,
          customerName: customers.displayName,
          vendorId: payments.vendorId,
          vendorName: vendors.displayName,
          bankAccountId: payments.bankAccountId,
          postedJournalEntryId: payments.postedJournalEntryId,
          voidedJournalEntryId: payments.voidedJournalEntryId,
          voidedAt: payments.voidedAt,
          createdAt: payments.createdAt,
        })
        .from(payments)
        .leftJoin(customers, eq(customers.id, payments.customerId))
        .leftJoin(vendors, eq(vendors.id, payments.vendorId))
        .where(
          and(
            q.type === undefined ? undefined : eq(payments.paymentType, q.type),
            q.customerId === undefined ? undefined : eq(payments.customerId, q.customerId),
            q.vendorId === undefined ? undefined : eq(payments.vendorId, q.vendorId),
            q.status === undefined ? undefined : eq(payments.status, q.status),
          ),
        )
        .orderBy(desc(payments.paymentDate), desc(payments.createdAt));
      return { payments: rows };
    });
  });

  app.post('/payments', async (req, reply) => {
    const body = CreatePaymentSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        createPayment(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof PaymentError) {
        const status = err.code === 'over_application' || err.code === 'amount_mismatch' ? 422 : 422;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/payments/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const [head] = await tx
        .select({
          id: payments.id,
          paymentType: payments.paymentType,
          paymentDate: payments.paymentDate,
          paymentMethod: payments.paymentMethod,
          reference: payments.reference,
          amount: payments.amount,
          status: payments.status,
          memo: payments.memo,
          customerId: payments.customerId,
          customerName: customers.displayName,
          vendorId: payments.vendorId,
          vendorName: vendors.displayName,
          bankAccountId: payments.bankAccountId,
          postedJournalEntryId: payments.postedJournalEntryId,
          voidedJournalEntryId: payments.voidedJournalEntryId,
          voidedAt: payments.voidedAt,
          createdAt: payments.createdAt,
          updatedAt: payments.updatedAt,
        })
        .from(payments)
        .leftJoin(customers, eq(customers.id, payments.customerId))
        .leftJoin(vendors, eq(vendors.id, payments.vendorId))
        .where(eq(payments.id, id));
      if (!head) return reply.status(404).send({ error: 'not_found' });

      const apps = await tx
        .select()
        .from(paymentApplications)
        .where(eq(paymentApplications.paymentId, id));

      return { ...head, applications: apps };
    });
  });

  app.post('/payments/:id/void', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = VoidBody.parse(req.body ?? {});
    const today = new Date().toISOString().slice(0, 10);
    try {
      const result = await req.withTenantTx(async (tx) =>
        voidPayment(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
          { voidDate: body.voidDate ?? today, memo: body.memo },
        ),
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof PaymentError) {
        const status =
          err.code === 'not_found' ? 404 : err.code === 'already_voided' ? 409 : 422;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
