import {
  type Database,
  companies,
  customers,
  estimateLines,
  estimates,
  invoiceLines,
  invoices,
  taxRates,
} from '@kpbooks/db';
import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  type EstimateData,
  type InvoiceData,
  type SalesDocAddress,
  type SalesDocLine,
  renderSalesDoc,
} from '../modules/forms/sales-doc.js';

/**
 * /v1/invoices/:id.pdf  +  /v1/estimates/:id.pdf
 *
 * Streams a printable PDF of the document. Both routes load the same
 * kind of context (head + lines + tax rate label + customer + payer
 * company) and hand it to the shared sales-doc renderer with the
 * appropriate `kind` discriminator.
 */

export const salesDocPdfRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/invoices/:id.pdf', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const ctx = await loadInvoiceContext(tx, id, req.auth!.companyId!);
      if (!ctx) return reply.status(404).send({ error: 'not_found' });
      const pdf = await renderSalesDoc(ctx);
      const safeName = `Invoice_${ctx.documentNumber.replace(/[^A-Za-z0-9]+/g, '_')}.pdf`;
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
      reply.header('Content-Length', String(pdf.length));
      return reply.send(pdf);
    });
  });

  app.get('/estimates/:id.pdf', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const ctx = await loadEstimateContext(tx, id, req.auth!.companyId!);
      if (!ctx) return reply.status(404).send({ error: 'not_found' });
      const pdf = await renderSalesDoc(ctx);
      const safeName = `Estimate_${ctx.documentNumber.replace(/[^A-Za-z0-9]+/g, '_')}.pdf`;
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
      reply.header('Content-Length', String(pdf.length));
      return reply.send(pdf);
    });
  });
};

function addressFromJson(j: Record<string, unknown> | null | undefined): SalesDocAddress {
  if (!j || typeof j !== 'object') return {};
  return {
    ...(typeof j.street1 === 'string' ? { street1: j.street1 } : {}),
    ...(typeof j.street2 === 'string' ? { street2: j.street2 } : {}),
    ...(typeof j.city === 'string' ? { city: j.city } : {}),
    ...(typeof j.state === 'string' ? { state: j.state } : {}),
    ...(typeof j.postalCode === 'string' ? { postalCode: j.postalCode } : {}),
  };
}

async function loadCommonShell(tx: Database, companyId: string) {
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
  return company ?? null;
}

async function loadInvoiceContext(
  tx: Database,
  invoiceId: string,
  companyId: string,
): Promise<InvoiceData | null> {
  const [head] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  if (!head) return null;

  const [customer] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, head.customerId));
  if (!customer) return null;

  const company = await loadCommonShell(tx, companyId);
  if (!company) return null;

  const lines = await tx
    .select({
      lineNumber: invoiceLines.lineNumber,
      description: invoiceLines.description,
      quantity: invoiceLines.quantity,
      unitPrice: invoiceLines.unitPrice,
      amount: invoiceLines.amount,
      taxable: invoiceLines.taxable,
    })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(invoiceLines.lineNumber));

  let taxRateLabel: string | null = null;
  if (head.taxRateId) {
    const [rate] = await tx
      .select({ name: taxRates.name, ratePercent: taxRates.ratePercent })
      .from(taxRates)
      .where(eq(taxRates.id, head.taxRateId));
    if (rate) {
      taxRateLabel = `${rate.name} ${Number(rate.ratePercent).toFixed(2)}%`;
    }
  }

  return {
    kind: 'invoice',
    payer: {
      name: company.name,
      legalName: company.legalName,
      ein: company.ein,
      address: addressFromJson(company.address as Record<string, unknown> | null),
      phone: company.phone,
    },
    customer: {
      name: customer.displayName,
      companyName: customer.companyName,
      email: customer.email,
      address: addressFromJson(customer.billingAddress as Record<string, unknown> | null),
      accountNumber: customer.accountNumber,
    },
    documentNumber: head.invoiceNumber,
    invoiceDate: head.invoiceDate,
    dueDate: head.dueDate,
    termsDays: head.termsDays,
    status: head.status,
    memo: head.memo,
    lines: lines as SalesDocLine[],
    subtotal: head.subtotal,
    taxRateLabel,
    taxAmount: head.taxAmount,
    total: head.total,
    balanceDue: head.balanceDue,
  };
}

async function loadEstimateContext(
  tx: Database,
  estimateId: string,
  companyId: string,
): Promise<EstimateData | null> {
  const [head] = await tx
    .select()
    .from(estimates)
    .where(eq(estimates.id, estimateId));
  if (!head) return null;

  const [customer] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, head.customerId));
  if (!customer) return null;

  const company = await loadCommonShell(tx, companyId);
  if (!company) return null;

  const lines = await tx
    .select({
      lineNumber: estimateLines.lineNumber,
      description: estimateLines.description,
      quantity: estimateLines.quantity,
      unitPrice: estimateLines.unitPrice,
      amount: estimateLines.amount,
      taxable: estimateLines.taxable,
    })
    .from(estimateLines)
    .where(eq(estimateLines.estimateId, estimateId))
    .orderBy(asc(estimateLines.lineNumber));

  let taxRateLabel: string | null = null;
  if (head.taxRateId) {
    const [rate] = await tx
      .select({ name: taxRates.name, ratePercent: taxRates.ratePercent })
      .from(taxRates)
      .where(eq(taxRates.id, head.taxRateId));
    if (rate) {
      taxRateLabel = `${rate.name} ${Number(rate.ratePercent).toFixed(2)}%`;
    }
  }

  let convertedInvoiceNumber: string | null = null;
  if (head.convertedInvoiceId) {
    const [inv] = await tx
      .select({ invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(eq(invoices.id, head.convertedInvoiceId));
    if (inv) convertedInvoiceNumber = inv.invoiceNumber;
  }

  return {
    kind: 'estimate',
    payer: {
      name: company.name,
      legalName: company.legalName,
      ein: company.ein,
      address: addressFromJson(company.address as Record<string, unknown> | null),
      phone: company.phone,
    },
    customer: {
      name: customer.displayName,
      companyName: customer.companyName,
      email: customer.email,
      address: addressFromJson(customer.billingAddress as Record<string, unknown> | null),
      accountNumber: customer.accountNumber,
    },
    documentNumber: head.estimateNumber,
    estimateDate: head.estimateDate,
    expirationDate: head.expirationDate,
    termsDays: head.termsDays,
    status: head.status,
    memo: head.memo,
    lines: lines as SalesDocLine[],
    subtotal: head.subtotal,
    taxRateLabel,
    taxAmount: head.taxAmount,
    total: head.total,
    convertedInvoiceNumber,
  };
}
