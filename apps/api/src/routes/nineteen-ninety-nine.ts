import { type Database, companies, vendors, workerDocuments } from '@kpbooks/db';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  preflight1099NEC,
  render1099NEC,
  render1099NECCopies,
  type Address,
  type CopyType,
} from '../modules/forms/1099-nec.js';

/**
 * Routes for IRS 1099-NEC PDF generation.
 *
 * - GET /workers/:id/1099-nec/preflight?year=YYYY -> {issues:[]}
 * - GET /workers/:id/1099-nec.pdf?year=YYYY&copy=B|C|all -> application/pdf
 *
 * Pre-flight is exposed separately so the UI can show a friendly "missing
 * fields" panel without triggering a download.
 */

const CopyParam = z.enum(['B', 'C', '1', '2', 'all']);

const Query = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  copy: CopyParam.default('B'),
});

interface PaymentSumRow {
  total: string;
}

export const nineteenNinetyNineRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/workers/:id/1099-nec/preflight', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { year } = z
      .object({ year: z.coerce.number().int().min(2000).max(2100) })
      .parse(req.query);

    return req.withTenantTx(async (tx) => {
      const ctx = await loadFormContext(tx, id, year, req.auth!.companyId!);
      if (!ctx) return reply.status(404).send({ error: 'not_found' });
      const issues = preflight1099NEC({
        payer: {
          name: ctx.payer.name,
          ein: ctx.payer.ein ?? null,
          address: ctx.payer.address,
          phone: ctx.payer.phone ?? null,
        },
        recipient: {
          displayName: ctx.recipient.displayName,
          taxId: ctx.recipient.taxId ?? null,
          mailingAddress: ctx.recipient.address,
        },
        hasW9: ctx.hasW9,
        nonemployeeCompensation: ctx.yearTotal,
      });
      return {
        year,
        vendorId: id,
        issues,
        nonemployeeCompensation: ctx.yearTotal,
        payer: ctx.payer,
        recipient: ctx.recipient,
        hasW9: ctx.hasW9,
      };
    });
  });

  app.get('/workers/:id/1099-nec.pdf', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { year, copy } = Query.parse(req.query);

    return req.withTenantTx(async (tx) => {
      const ctx = await loadFormContext(tx, id, year, req.auth!.companyId!);
      if (!ctx) return reply.status(404).send({ error: 'not_found' });

      const issues = preflight1099NEC({
        payer: {
          name: ctx.payer.name,
          ein: ctx.payer.ein ?? null,
          address: ctx.payer.address,
          phone: ctx.payer.phone ?? null,
        },
        recipient: {
          displayName: ctx.recipient.displayName,
          taxId: ctx.recipient.taxId ?? null,
          mailingAddress: ctx.recipient.address,
        },
        hasW9: ctx.hasW9,
        nonemployeeCompensation: ctx.yearTotal,
      });
      // Block PDF generation only when fields that must appear on the form
      // are missing. The W-9 missing + below-threshold issues are warnings;
      // we let the PDF generate with a flag so the user can still save it.
      const blockers = issues.filter(
        (i) => i.fix === 'company-settings' || i.fix === 'worker-edit',
      );
      if (blockers.length > 0) {
        return reply.status(422).send({
          error: 'preflight_failed',
          message: 'cannot generate 1099-NEC: required fields missing',
          issues,
        });
      }

      const data = {
        payer: {
          name: ctx.payer.name,
          legalName: ctx.payer.legalName ?? null,
          ein: ctx.payer.ein!,
          address: ctx.payer.address,
          phone: ctx.payer.phone ?? null,
        },
        recipient: {
          name: ctx.recipient.displayName,
          taxId: ctx.recipient.taxId!,
          accountNumber: ctx.recipient.accountNumber ?? null,
          address: ctx.recipient.address,
        },
        taxYear: year,
        nonemployeeCompensation: ctx.yearTotal,
      };

      const pdf =
        copy === 'all'
          ? await render1099NECCopies(data, ['B', 'C'] as CopyType[])
          : await render1099NEC(data, copy as CopyType);

      const safeName = `${ctx.recipient.displayName.replace(/[^A-Za-z0-9]+/g, '_')}_1099-NEC_${year}_Copy${copy}.pdf`;
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
      reply.header('Content-Length', String(pdf.length));
      return reply.send(pdf);
    });
  });
};

interface FormContext {
  payer: {
    name: string;
    legalName: string | null;
    ein: string | null;
    address: Address;
    phone: string | null;
  };
  recipient: {
    displayName: string;
    taxId: string | null;
    address: Address;
    accountNumber: string | null;
  };
  hasW9: boolean;
  yearTotal: string;
}

async function loadFormContext(
  tx: Database,
  vendorId: string,
  year: number,
  companyId: string,
): Promise<FormContext | null> {
  const [vendor] = await tx
    .select()
    .from(vendors)
    .where(eq(vendors.id, vendorId));
  if (!vendor) return null;

  const [company] = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!company) return null;

  // Year total of posted vendor_sent payments (matches reports.service 1099 query).
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const totalRows = await tx.execute(sql`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM payments
    WHERE vendor_id = ${vendorId}
      AND payment_type = 'vendor_sent'
      AND status = 'posted'
      AND payment_date BETWEEN ${yearStart}::date AND ${yearEnd}::date
  `);
  const totalRow = (totalRows as unknown as PaymentSumRow[])[0];
  const yearTotal = String(totalRow?.total ?? '0');

  // W-9 presence check.
  const w9 = await tx
    .select({ id: workerDocuments.id })
    .from(workerDocuments)
    .where(and(eq(workerDocuments.vendorId, vendorId), eq(workerDocuments.documentType, 'w9')))
    .limit(1);

  return {
    payer: {
      name: company.name,
      legalName: company.legalName,
      ein: company.ein,
      address: (company.address as Address | null) ?? {},
      phone: company.phone,
    },
    recipient: {
      displayName: vendor.displayName,
      taxId: vendor.taxId,
      address: (vendor.mailingAddress as Address | null) ?? {},
      accountNumber: vendor.accountNumber,
    },
    hasW9: w9.length > 0,
    yearTotal,
  };
}
