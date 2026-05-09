import {
  type Database,
  companies,
  paymentApplications,
  payments,
  timeEntries,
  vendors,
} from '@kpbooks/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  renderPayStub,
  type PayStubData,
  type PayStubLine,
} from '../modules/forms/pay-stub.js';

/**
 * GET /v1/payments/:id/pay-stub.pdf
 *
 * Generates a printable pay-stub PDF for a single vendor_sent payment.
 *
 * Data sources:
 *   - payments + payment_applications: which bills this payment paid
 *   - time_entries (where billed_bill_id IN those bill ids): line-level
 *     hours / rate / description, so the stub itemizes the work
 *   - companies + vendors: payer + recipient info (name, address)
 *   - sum of YTD vendor_sent payments for the vendor: YTD column
 *
 * If the payment paid bills NOT built from time entries, the stub falls
 * back to a single "Services rendered" line for the full amount.
 */

const Address = z.object({
  street1: z.string().optional(),
  street2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
});

export const payStubsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/payments/:id/pay-stub.pdf', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.withTenantTx(async (tx) => {
      const data = await loadPayStubContext(tx, id, req.auth!.companyId!);
      if (!data) return reply.status(404).send({ error: 'not_found' });

      const pdf = await renderPayStub(data);
      const safeName = `${data.recipient.name.replace(/[^A-Za-z0-9]+/g, '_')}_PayStub_${data.payDate}.pdf`;
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
      reply.header('Content-Length', String(pdf.length));
      return reply.send(pdf);
    });
  });
};

async function loadPayStubContext(
  tx: Database,
  paymentId: string,
  companyId: string,
): Promise<PayStubData | null> {
  // 1. Payment
  const [payment] = await tx
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId));
  if (!payment) return null;
  if (payment.paymentType !== 'vendor_sent' || !payment.vendorId) {
    // Customer-received payments aren't pay stubs -- those would be receipts.
    return null;
  }

  // 2. Vendor + company
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, payment.vendorId));
  if (!vendor) return null;
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
  if (!company) return null;

  // 3. Applied bills -> time entries that line them up
  const apps = await tx
    .select({ billId: paymentApplications.billId, amount: paymentApplications.amount })
    .from(paymentApplications)
    .where(eq(paymentApplications.paymentId, paymentId));
  const billIds = apps.map((a) => a.billId).filter((b): b is string => !!b);
  let lines: PayStubLine[] = [];
  if (billIds.length > 0) {
    const timeRows = await tx
      .select({
        entryDate: timeEntries.entryDate,
        description: timeEntries.description,
        hours: timeEntries.hours,
        rate: timeEntries.rate,
        amount: timeEntries.amount,
        project: timeEntries.project,
      })
      .from(timeEntries)
      .where(inArray(timeEntries.billedBillId, billIds));
    lines = timeRows.map((t) => ({
      entryDate: t.entryDate,
      description: t.project ? `[${t.project}] ${t.description}` : t.description,
      hours: t.hours,
      rate: t.rate,
      amount: t.amount,
    }));
  }

  // 4. YTD totals (calendar year of the pay date).
  const year = payment.paymentDate.slice(0, 4);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const ytdRows = await tx.execute(sql`
    SELECT COALESCE(SUM(amount), 0) AS ytd
    FROM payments
    WHERE vendor_id = ${payment.vendorId}
      AND payment_type = 'vendor_sent'
      AND status = 'posted'
      AND payment_date BETWEEN ${yearStart}::date AND ${yearEnd}::date
  `);
  const ytdGross = String((ytdRows as unknown as Array<{ ytd: string }>)[0]?.ytd ?? '0');

  // 5. Period (best-effort: min/max entry dates if we have any, else just the pay date).
  let periodStart: string | undefined;
  let periodEnd: string | undefined;
  if (lines.length > 0) {
    const dates = lines.map((l) => l.entryDate).filter((d): d is string => !!d).sort();
    if (dates.length > 0) {
      periodStart = dates[0];
      periodEnd = dates[dates.length - 1];
    }
  }

  const payerAddress = (company.address as z.infer<typeof Address> | null) ?? {};
  const recipientAddress = (vendor.mailingAddress as z.infer<typeof Address> | null) ?? {};

  const workerType: 'contractor' | 'employee' | null =
    vendor.workerType === 'contractor' || vendor.workerType === 'employee'
      ? vendor.workerType
      : null;

  return {
    payer: {
      name: company.name,
      legalName: company.legalName,
      ein: company.ein,
      address: payerAddress,
      phone: company.phone,
    },
    recipient: {
      name: vendor.displayName,
      taxId: vendor.taxId,
      address: recipientAddress,
      workerType,
    },
    payDate: payment.paymentDate,
    ...(periodStart ? { periodStart } : {}),
    ...(periodEnd ? { periodEnd } : {}),
    checkNumber: payment.reference,
    paymentMethod: payment.paymentMethod,
    memo: payment.memo,
    lines,
    grossCurrent: payment.amount,
    grossYtd: ytdGross,
    deductions: [],
  };
}

/** Re-export for typing. */
export type { PayStubData };
// Avoid unused import lint: we import `and` for parity with other route files.
void and;
