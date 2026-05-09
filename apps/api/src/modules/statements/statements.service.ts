import { type Database, companies, customers, invoices, payments } from '@kpbooks/db';
import { Money } from '@kpbooks/money';
import { eq, sql } from 'drizzle-orm';
import { arAging } from '../ledger/reports.service.js';
import type {
  CustomerStatementData,
  StmtAddress,
  StmtAging,
  StmtRow,
} from '../forms/customer-statement.js';

/**
 * statements.service -- A/R statement of account.
 *
 * Aggregates invoices + payments for one customer over a period and returns
 * the data shape the customer-statement renderer wants. Computes opening
 * balance (everything before periodStart), every activity row inside the
 * period, the running balance after each row, and the closing balance.
 *
 * Aging at periodEnd uses the existing arAging report query so the numbers
 * agree with the "A/R Aging" report the user already trusts.
 */

export class StatementError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'invalid_input',
  ) {
    super(message);
    this.name = 'StatementError';
  }
}

interface CustomerRow {
  id: string;
  displayName: string;
  companyName: string | null;
  accountNumber: string | null;
  email: string | null;
  mailingAddress: Record<string, unknown> | null;
}

interface CompanyRow {
  name: string;
  legalName: string | null;
  address: Record<string, unknown> | null;
  phone: string | null;
}

/**
 * Build the full data shape for the customer-statement renderer.
 *
 *   openingBalance = sum(invoices.total before periodStart)
 *                    - sum(payments.amount before periodStart)
 *
 *   For each activity row inside [periodStart, periodEnd]:
 *     - invoice -> charge column = total, payment column = ''
 *     - payment -> charge column = '', payment column = amount
 *   running balance after each row computed forward from opening.
 *
 *   closingBalance = balance after the last row.
 *
 *   aging = arAging(periodEnd), filtered to this customer.
 */
export async function buildStatementData(
  tx: Database,
  companyId: string,
  customerId: string,
  periodStart: string,
  periodEnd: string,
  asOf?: string,
): Promise<CustomerStatementData> {
  if (periodEnd < periodStart) {
    throw new StatementError('periodEnd must be on or after periodStart', 'invalid_input');
  }

  const [customer] = (await tx
    .select({
      id: customers.id,
      displayName: customers.displayName,
      companyName: customers.companyName,
      accountNumber: customers.accountNumber,
      email: customers.email,
      mailingAddress: customers.billingAddress,
    })
    .from(customers)
    .where(eq(customers.id, customerId))) as unknown as CustomerRow[];
  if (!customer) {
    throw new StatementError(`customer ${customerId} not found`, 'not_found');
  }

  const [company] = (await tx
    .select({
      name: companies.name,
      legalName: companies.legalName,
      address: companies.address,
      phone: companies.phone,
    })
    .from(companies)
    .where(eq(companies.id, companyId))) as unknown as CompanyRow[];
  if (!company) {
    throw new StatementError(`company ${companyId} not found`, 'not_found');
  }

  // --- Opening balance: aggregate before periodStart -----------------------
  const openingRows = await tx.execute(sql`
    SELECT
      COALESCE((
        SELECT SUM(total) FROM invoices
        WHERE customer_id = ${customerId}
          AND status <> 'void'
          AND invoice_date < ${periodStart}::date
      ), 0) AS invoiced_before,
      COALESCE((
        SELECT SUM(amount) FROM payments
        WHERE customer_id = ${customerId}
          AND payment_type = 'customer_received'
          AND status = 'posted'
          AND payment_date < ${periodStart}::date
      ), 0) AS paid_before
  `);
  const open = (openingRows as unknown as Array<Record<string, unknown>>)[0];
  const openingBalance = Money.of(String(open?.invoiced_before ?? '0'), 'USD').sub(
    Money.of(String(open?.paid_before ?? '0'), 'USD'),
  );

  // --- Period activity rows: invoices + payments ---------------------------
  const periodInvoices = await tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      memo: invoices.memo,
      total: invoices.total,
      status: invoices.status,
    })
    .from(invoices)
    .where(
      sql`${invoices.customerId} = ${customerId}
        AND ${invoices.status} <> 'void'
        AND ${invoices.invoiceDate} BETWEEN ${periodStart}::date AND ${periodEnd}::date`,
    )
    .orderBy(invoices.invoiceDate, invoices.createdAt);

  const periodPayments = await tx
    .select({
      id: payments.id,
      reference: payments.reference,
      paymentDate: payments.paymentDate,
      paymentMethod: payments.paymentMethod,
      memo: payments.memo,
      amount: payments.amount,
    })
    .from(payments)
    .where(
      sql`${payments.customerId} = ${customerId}
        AND ${payments.paymentType} = 'customer_received'
        AND ${payments.status} = 'posted'
        AND ${payments.paymentDate} BETWEEN ${periodStart}::date AND ${periodEnd}::date`,
    )
    .orderBy(payments.paymentDate, payments.createdAt);

  type ActivitySource =
    | { kind: 'invoice'; date: string; row: (typeof periodInvoices)[number] }
    | { kind: 'payment'; date: string; row: (typeof periodPayments)[number] };
  const activity: ActivitySource[] = [
    ...periodInvoices.map((r) => ({ kind: 'invoice' as const, date: r.invoiceDate, row: r })),
    ...periodPayments.map((r) => ({ kind: 'payment' as const, date: r.paymentDate, row: r })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  // --- Running balance over the activity ----------------------------------
  let running = openingBalance;
  const rows: StmtRow[] = [];

  // Always include the opening line so the customer can see the balance forward.
  rows.push({
    date: periodStart,
    type: 'opening',
    reference: '',
    description: 'Balance forward',
    charge: '0',
    paymentAmount: '0',
    runningBalance: running.toPgNumeric(),
  });

  for (const a of activity) {
    if (a.kind === 'invoice') {
      const charge = Money.of(a.row.total, 'USD');
      running = running.add(charge);
      rows.push({
        date: a.row.invoiceDate,
        type: 'invoice',
        reference: a.row.invoiceNumber,
        description: a.row.memo ?? `Invoice ${a.row.invoiceNumber}`,
        charge: charge.toPgNumeric(),
        paymentAmount: '0',
        runningBalance: running.toPgNumeric(),
      });
    } else {
      const pay = Money.of(a.row.amount, 'USD');
      running = running.sub(pay);
      const ref = a.row.reference ? `${a.row.paymentMethod} #${a.row.reference}` : a.row.paymentMethod;
      rows.push({
        date: a.row.paymentDate,
        type: 'payment',
        reference: ref,
        description: a.row.memo ?? 'Payment received',
        charge: '0',
        paymentAmount: pay.toPgNumeric(),
        runningBalance: running.toPgNumeric(),
      });
    }
  }

  const closingBalance = running;

  // --- Aging at periodEnd (re-uses the shared report query) ---------------
  const agingReport = await arAging(tx, periodEnd);
  const ourRow = agingReport.rows.find((r) => r.counterpartyId === customerId);
  const aging: StmtAging = ourRow
    ? {
        current: ourRow.current,
        days1to30: ourRow.days1to30,
        days31to60: ourRow.days31to60,
        days61to90: ourRow.days61to90,
        days91plus: ourRow.days91plus,
        total: ourRow.total,
      }
    : {
        current: '0',
        days1to30: '0',
        days31to60: '0',
        days61to90: '0',
        days91plus: '0',
        total: '0',
      };

  return {
    payer: {
      name: company.name,
      legalName: company.legalName,
      address: addressFromJson(company.address),
      phone: company.phone,
    },
    customer: {
      name: customer.displayName,
      companyName: customer.companyName,
      accountNumber: customer.accountNumber,
      address: addressFromJson(customer.mailingAddress),
    },
    periodStart,
    periodEnd,
    asOf: asOf ?? periodEnd,
    openingBalance: openingBalance.toPgNumeric(),
    closingBalance: closingBalance.toPgNumeric(),
    rows,
    aging,
  };
}

function addressFromJson(j: Record<string, unknown> | null): StmtAddress {
  if (!j || typeof j !== 'object') return {};
  return {
    ...(typeof j.street1 === 'string' ? { street1: j.street1 } : {}),
    ...(typeof j.street2 === 'string' ? { street2: j.street2 } : {}),
    ...(typeof j.city === 'string' ? { city: j.city } : {}),
    ...(typeof j.state === 'string' ? { state: j.state } : {}),
    ...(typeof j.postalCode === 'string' ? { postalCode: j.postalCode } : {}),
  };
}

/**
 * List of customers eligible for a bulk statement run -- those with non-zero
 * activity in the period or a non-zero closing balance. Returns enough info
 * for the bulk UI to confirm the target list before generating PDFs.
 */
export interface BulkStatementCandidate {
  customerId: string;
  displayName: string;
  email: string | null;
  closingBalance: string;
  activityRowCount: number;
}

export async function listBulkStatementCandidates(
  tx: Database,
  periodStart: string,
  periodEnd: string,
): Promise<BulkStatementCandidate[]> {
  const rows = await tx.execute(sql`
    SELECT
      c.id            AS customer_id,
      c.display_name  AS display_name,
      c.email         AS email,
      COALESCE((
        SELECT SUM(total) FROM invoices
        WHERE customer_id = c.id AND status <> 'void' AND invoice_date <= ${periodEnd}::date
      ), 0) -
      COALESCE((
        SELECT SUM(amount) FROM payments
        WHERE customer_id = c.id AND payment_type = 'customer_received'
          AND status = 'posted' AND payment_date <= ${periodEnd}::date
      ), 0) AS closing_balance,
      (
        SELECT COUNT(*) FROM invoices
        WHERE customer_id = c.id AND status <> 'void'
          AND invoice_date BETWEEN ${periodStart}::date AND ${periodEnd}::date
      ) +
      (
        SELECT COUNT(*) FROM payments
        WHERE customer_id = c.id AND payment_type = 'customer_received'
          AND status = 'posted'
          AND payment_date BETWEEN ${periodStart}::date AND ${periodEnd}::date
      ) AS activity_row_count
    FROM customers c
    WHERE c.is_active = true
    ORDER BY c.display_name
  `);
  const out: BulkStatementCandidate[] = [];
  for (const r of rows as unknown as Array<Record<string, unknown>>) {
    const closing = Number(r.closing_balance ?? 0);
    const activity = Number(r.activity_row_count ?? 0);
    if (closing === 0 && activity === 0) continue; // no statement needed
    out.push({
      customerId: String(r.customer_id),
      displayName: String(r.display_name),
      email: r.email ? String(r.email) : null,
      closingBalance: String(r.closing_balance ?? '0'),
      activityRowCount: activity,
    });
  }
  return out;
}
