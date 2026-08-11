import {
  type Database,
  companies,
  paymentApplications,
  payments,
  payrollRunLines,
  payrollRuns,
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

  // 4. Payroll-run line for this payment, if the payment came from a pay run.
  // Pay-run payments post at NET (withholdings are display-only), so the stub
  // must pull gross + deduction columns from the run line — otherwise a W-2
  // stub prints gross = net with no withholdings.
  const [runLine] = await tx
    .select({
      gross: payrollRunLines.gross,
      federalIncomeTax: payrollRunLines.federalIncomeTax,
      socialSecurity: payrollRunLines.socialSecurity,
      medicare: payrollRunLines.medicare,
      stateIncomeTax: payrollRunLines.stateIncomeTax,
      otherDeductions: payrollRunLines.otherDeductions,
      net: payrollRunLines.net,
      hours: payrollRunLines.hours,
      rate: payrollRunLines.rate,
      runPeriodStart: payrollRuns.periodStart,
      runPeriodEnd: payrollRuns.periodEnd,
    })
    .from(payrollRunLines)
    .innerJoin(payrollRuns, eq(payrollRuns.id, payrollRunLines.payrollRunId))
    .where(eq(payrollRunLines.postedPaymentId, paymentId));

  // 5. YTD totals (calendar year of the pay date).
  const year = payment.paymentDate.slice(0, 4);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  let ytdGross: string;
  let deductions: PayStubData['deductions'];
  let netYtd: string | undefined;
  if (runLine) {
    // Payroll-run payment: YTD figures come from posted run lines (gross
    // basis), not from net payment amounts.
    const ytdRows = await tx.execute(sql`
      SELECT
        COALESCE(SUM(l.gross), 0)              AS gross,
        COALESCE(SUM(l.federal_income_tax), 0) AS fit,
        COALESCE(SUM(l.social_security), 0)    AS ss,
        COALESCE(SUM(l.medicare), 0)           AS medicare,
        COALESCE(SUM(l.state_income_tax), 0)   AS sit,
        COALESCE(SUM(l.other_deductions), 0)   AS other,
        COALESCE(SUM(l.net), 0)                AS net
      FROM payroll_run_lines l
      JOIN payroll_runs r ON r.id = l.payroll_run_id
      WHERE l.vendor_id = ${payment.vendorId}
        AND r.status = 'posted'
        AND r.pay_date BETWEEN ${yearStart}::date AND ${yearEnd}::date
    `);
    const ytd = (ytdRows as unknown as Array<Record<string, unknown>>)[0] ?? {};
    ytdGross = String(ytd.gross ?? '0');
    netYtd = String(ytd.net ?? '0');
    const candidates: Array<{ label: string; current: string; ytd: string }> = [
      { label: 'Federal income tax', current: runLine.federalIncomeTax, ytd: String(ytd.fit ?? '0') },
      { label: 'Social Security', current: runLine.socialSecurity, ytd: String(ytd.ss ?? '0') },
      { label: 'Medicare', current: runLine.medicare, ytd: String(ytd.medicare ?? '0') },
      { label: 'State income tax', current: runLine.stateIncomeTax, ytd: String(ytd.sit ?? '0') },
      { label: 'Other deductions', current: runLine.otherDeductions, ytd: String(ytd.other ?? '0') },
    ];
    deductions = candidates.filter((d) => Number(d.current) !== 0 || Number(d.ytd) !== 0);
  } else {
    const ytdRows = await tx.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS ytd
      FROM payments
      WHERE vendor_id = ${payment.vendorId}
        AND payment_type = 'vendor_sent'
        AND status = 'posted'
        AND payment_date BETWEEN ${yearStart}::date AND ${yearEnd}::date
    `);
    ytdGross = String((ytdRows as unknown as Array<{ ytd: string }>)[0]?.ytd ?? '0');
    deductions = [];
  }

  // 6. Period: prefer the pay run's period; else best-effort min/max time-entry dates.
  let periodStart: string | undefined = runLine?.runPeriodStart;
  let periodEnd: string | undefined = runLine?.runPeriodEnd;
  if (!periodStart && lines.length > 0) {
    const dates = lines.map((l) => l.entryDate).filter((d): d is string => !!d).sort();
    if (dates.length > 0) {
      periodStart = dates[0];
      periodEnd = dates[dates.length - 1];
    }
  }

  // Payroll-run payments with no time entries: show an hours/rate earnings
  // line from the run line itself when available.
  if (runLine && lines.length === 0 && runLine.hours && runLine.rate) {
    lines = [
      {
        description: 'Wages',
        hours: runLine.hours,
        rate: runLine.rate,
        amount: runLine.gross,
      },
    ];
  }

  const payerAddress = (company.address as z.infer<typeof Address> | null) ?? {};
  const recipientAddress = (vendor.mailingAddress as z.infer<typeof Address> | null) ?? {};

  // Subcontractors get 1099 treatment identical to contractors on the stub
  // (the renderer only distinguishes contractor vs employee footnotes).
  const workerType: 'contractor' | 'employee' | null =
    vendor.workerType === 'contractor' || vendor.workerType === 'subcontractor'
      ? 'contractor'
      : vendor.workerType === 'employee'
        ? 'employee'
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
    // For payroll-run payments the payment row is NET; gross lives on the run line.
    grossCurrent: runLine ? runLine.gross : payment.amount,
    grossYtd: ytdGross,
    deductions,
    ...(runLine ? { netCurrent: runLine.net } : {}),
    ...(netYtd !== undefined ? { netYtd } : {}),
  };
}

/** Re-export for typing. */
export type { PayStubData };
// Avoid unused import lint: we import `and` for parity with other route files.
void and;
