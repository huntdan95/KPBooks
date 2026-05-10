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
import {
  preflight1099MISC,
  render1099MISC,
  render1099MISCCopies,
  type NineteenNinetyNineMISCData,
} from '../modules/forms/1099-misc.js';

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

  // ─── 1099-MISC ────────────────────────────────────────────────────────
  // The MISC form supports many income boxes (rents, royalties, medical,
  // attorney, etc.). The route accepts each box as an optional decimal
  // string in the query so the UI can populate one or several. If no
  // boxes are passed, we default Box 1 (rents) to YTD vendor payments --
  // matches the most common use case (landlords).

  const MiscBoxes = z
    .object({
      rents: z.string().optional(),
      royalties: z.string().optional(),
      otherIncome: z.string().optional(),
      federalIncomeTaxWithheld: z.string().optional(),
      fishingBoatProceeds: z.string().optional(),
      medicalPayments: z.string().optional(),
      directSalesCheckbox: z.enum(['true', 'false']).optional(),
      substitutePayments: z.string().optional(),
      cropInsurance: z.string().optional(),
      attorneyProceeds: z.string().optional(),
      fishPurchased: z.string().optional(),
      section409aDeferrals: z.string().optional(),
      fatcaCheckbox: z.enum(['true', 'false']).optional(),
      excessGoldenParachute: z.string().optional(),
      nonqualifiedDeferred: z.string().optional(),
      stateTaxWithheld: z.string().optional(),
      payerStateId: z.string().optional(),
      stateIncome: z.string().optional(),
    })
    .strict();

  app.get('/workers/:id/1099-misc/preflight', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { year, ...rawBoxes } = z
      .object({ year: z.coerce.number().int().min(2000).max(2100) })
      .passthrough()
      .parse(req.query);
    const boxes = MiscBoxes.parse(rawBoxes);

    return req.withTenantTx(async (tx) => {
      const ctx = await loadFormContext(tx, id, year, req.auth!.companyId!);
      if (!ctx) return reply.status(404).send({ error: 'not_found' });

      // Default rents to YTD payments if no boxes are passed (most common
      // 1099-MISC scenario is landlord rent).
      const populated = Object.values(boxes).some(
        (v) => typeof v === 'string' && v !== '' && v !== 'false',
      );
      const effectiveBoxes = populated ? boxes : { ...boxes, rents: ctx.yearTotal };

      const issues = preflight1099MISC({
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
        boxes: effectiveBoxes,
      });
      return {
        year,
        vendorId: id,
        issues,
        yearTotal: ctx.yearTotal,
        boxes: effectiveBoxes,
        defaultedToRents: !populated,
        payer: ctx.payer,
        recipient: ctx.recipient,
        hasW9: ctx.hasW9,
      };
    });
  });

  app.get('/workers/:id/1099-misc.pdf', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { year, copy, ...rawBoxes } = z
      .object({
        year: z.coerce.number().int().min(2000).max(2100),
        copy: CopyParam.default('B'),
      })
      .passthrough()
      .parse(req.query);
    const boxes = MiscBoxes.parse(rawBoxes);

    return req.withTenantTx(async (tx) => {
      const ctx = await loadFormContext(tx, id, year, req.auth!.companyId!);
      if (!ctx) return reply.status(404).send({ error: 'not_found' });

      const populated = Object.values(boxes).some(
        (v) => typeof v === 'string' && v !== '' && v !== 'false',
      );
      const effectiveBoxes = populated ? boxes : { ...boxes, rents: ctx.yearTotal };

      const issues = preflight1099MISC({
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
        boxes: effectiveBoxes,
      });
      const blockers = issues.filter(
        (i) => i.fix === 'company-settings' || i.fix === 'worker-edit',
      );
      if (blockers.length > 0) {
        return reply.status(422).send({
          error: 'preflight_failed',
          message: 'cannot generate 1099-MISC: required fields missing',
          issues,
        });
      }

      const data: NineteenNinetyNineMISCData = {
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
        rents: effectiveBoxes.rents,
        royalties: effectiveBoxes.royalties,
        otherIncome: effectiveBoxes.otherIncome,
        federalIncomeTaxWithheld: effectiveBoxes.federalIncomeTaxWithheld,
        fishingBoatProceeds: effectiveBoxes.fishingBoatProceeds,
        medicalPayments: effectiveBoxes.medicalPayments,
        directSalesCheckbox: effectiveBoxes.directSalesCheckbox === 'true',
        substitutePayments: effectiveBoxes.substitutePayments,
        cropInsurance: effectiveBoxes.cropInsurance,
        attorneyProceeds: effectiveBoxes.attorneyProceeds,
        fishPurchased: effectiveBoxes.fishPurchased,
        section409aDeferrals: effectiveBoxes.section409aDeferrals,
        fatcaCheckbox: effectiveBoxes.fatcaCheckbox === 'true',
        excessGoldenParachute: effectiveBoxes.excessGoldenParachute,
        nonqualifiedDeferred: effectiveBoxes.nonqualifiedDeferred,
        stateTaxWithheld: effectiveBoxes.stateTaxWithheld,
        payerStateId: effectiveBoxes.payerStateId,
        stateIncome: effectiveBoxes.stateIncome,
      };

      const pdf =
        copy === 'all'
          ? await render1099MISCCopies(data, ['B', 'C'] as CopyType[])
          : await render1099MISC(data, copy as CopyType);

      const safeName = `${ctx.recipient.displayName.replace(/[^A-Za-z0-9]+/g, '_')}_1099-MISC_${year}_Copy${copy}.pdf`;
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
