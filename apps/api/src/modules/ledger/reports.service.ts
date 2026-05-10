import type { Database } from '@kpbooks/db';
import { sql } from 'drizzle-orm';

/**
 * reports.service — read-only aggregations on top of the ledger.
 *
 * All queries assume RLS has scoped the transaction to a single company via
 * the app.current_company GUC. Numbers come back as decimal strings (from
 * NUMERIC) so Money.of(...) on the client side can format without precision loss.
 */

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface ProfitAndLossSection {
  accountId: string;
  code: string;
  name: string;
  amount: string;
}

export interface ProfitAndLoss {
  start: string;
  end: string;
  basis: 'accrual' | 'cash';
  revenue: ProfitAndLossSection[];
  expenses: ProfitAndLossSection[];
  totalRevenue: string;
  totalExpenses: string;
  netIncome: string;
}

export interface BalanceSheetSection {
  accountId: string;
  code: string;
  name: string;
  amount: string;
}

export interface BalanceSheet {
  asOf: string;
  assets: BalanceSheetSection[];
  liabilities: BalanceSheetSection[];
  equity: BalanceSheetSection[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  /** assets - (liabilities + equity); should be 0.0000 to the cent. */
  imbalance: string;
}

/**
 * Trial balance as of `asOf`. Returns one row per account with summed debits,
 * credits, and a signed balance using normal-balance conventions:
 *   asset, expense → debit positive
 *   liability, equity, revenue → credit positive
 */
export async function trialBalance(db: Database, asOf: string): Promise<TrialBalanceRow[]> {
  const rows = await db.execute(sql`
    SELECT
      a.id        AS account_id,
      a.code      AS code,
      a.name      AS name,
      a.type      AS type,
      a.subtype   AS subtype,
      COALESCE(SUM(jl.debit), 0)  AS debit,
      COALESCE(SUM(jl.credit), 0) AS credit,
      CASE
        WHEN a.type IN ('asset', 'expense')
          THEN COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
        ELSE COALESCE(SUM(jl.credit), 0) - COALESCE(SUM(jl.debit), 0)
      END AS balance
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je
           ON je.id = jl.entry_id
          AND je.entry_date <= ${asOf}::date
    WHERE a.is_active = true
    GROUP BY a.id, a.code, a.name, a.type, a.subtype
    HAVING COALESCE(SUM(jl.debit), 0) <> 0 OR COALESCE(SUM(jl.credit), 0) <> 0
    ORDER BY a.code
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    accountId: String(r.account_id),
    code: String(r.code),
    name: String(r.name),
    type: r.type as TrialBalanceRow['type'],
    subtype: String(r.subtype),
    debit: String(r.debit),
    credit: String(r.credit),
    balance: String(r.balance),
  }));
}

export async function profitAndLoss(
  db: Database,
  start: string,
  end: string,
  basis: 'accrual' | 'cash' = 'accrual',
): Promise<ProfitAndLoss> {
  // Cash basis is a v2 concern (requires payment-vs-invoice resolution); accrual is the default.
  if (basis === 'cash') {
    throw new Error('cash basis not implemented in v0; use accrual');
  }

  const rows = await db.execute(sql`
    SELECT
      a.id      AS account_id,
      a.code    AS code,
      a.name    AS name,
      a.type    AS type,
      CASE
        WHEN a.type = 'revenue'
          THEN COALESCE(SUM(jl.credit), 0) - COALESCE(SUM(jl.debit), 0)
        WHEN a.type = 'expense'
          THEN COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
      END AS amount
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je
           ON je.id = jl.entry_id
          AND je.entry_date BETWEEN ${start}::date AND ${end}::date
    WHERE a.type IN ('revenue', 'expense')
      AND a.is_active = true
    GROUP BY a.id, a.code, a.name, a.type
    ORDER BY a.code
  `);

  const revenue: ProfitAndLossSection[] = [];
  const expenses: ProfitAndLossSection[] = [];
  let totalRev = 0n;
  let totalExp = 0n;
  const SCALE = 10000n;

  for (const r of rows as unknown as Array<Record<string, unknown>>) {
    const amount = String(r.amount ?? '0');
    const section: ProfitAndLoss['revenue'][number] = {
      accountId: String(r.account_id),
      code: String(r.code),
      name: String(r.name),
      amount,
    };
    const minor = decimalToMinor(amount, SCALE);
    if (r.type === 'revenue') {
      revenue.push(section);
      totalRev += minor;
    } else {
      expenses.push(section);
      totalExp += minor;
    }
  }

  return {
    start,
    end,
    basis,
    revenue,
    expenses,
    totalRevenue: minorToDecimal(totalRev, SCALE),
    totalExpenses: minorToDecimal(totalExp, SCALE),
    netIncome: minorToDecimal(totalRev - totalExp, SCALE),
  };
}

export async function balanceSheet(db: Database, asOf: string): Promise<BalanceSheet> {
  const rows = await db.execute(sql`
    SELECT
      a.id   AS account_id,
      a.code AS code,
      a.name AS name,
      a.type AS type,
      CASE
        WHEN a.type = 'asset'
          THEN COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
        WHEN a.type IN ('liability', 'equity')
          THEN COALESCE(SUM(jl.credit), 0) - COALESCE(SUM(jl.debit), 0)
      END AS amount
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je
           ON je.id = jl.entry_id
          AND je.entry_date <= ${asOf}::date
    WHERE a.type IN ('asset', 'liability', 'equity')
      AND a.is_active = true
    GROUP BY a.id, a.code, a.name, a.type
    ORDER BY a.code
  `);

  const assets: BalanceSheetSection[] = [];
  const liabilities: BalanceSheetSection[] = [];
  const equity: BalanceSheetSection[] = [];
  const SCALE = 10000n;
  let totalAssets = 0n;
  let totalLiab = 0n;
  let totalEq = 0n;

  for (const r of rows as unknown as Array<Record<string, unknown>>) {
    const amount = String(r.amount ?? '0');
    const section = {
      accountId: String(r.account_id),
      code: String(r.code),
      name: String(r.name),
      amount,
    };
    const minor = decimalToMinor(amount, SCALE);
    if (r.type === 'asset') {
      assets.push(section);
      totalAssets += minor;
    } else if (r.type === 'liability') {
      liabilities.push(section);
      totalLiab += minor;
    } else {
      equity.push(section);
      totalEq += minor;
    }
  }

  // Compute YTD net income and roll into equity so the equation balances.
  // Caller is responsible for closing entries; we don't fabricate retained earnings here.
  const imbalance = totalAssets - (totalLiab + totalEq);

  return {
    asOf,
    assets,
    liabilities,
    equity,
    totalAssets: minorToDecimal(totalAssets, SCALE),
    totalLiabilities: minorToDecimal(totalLiab, SCALE),
    totalEquity: minorToDecimal(totalEq, SCALE),
    imbalance: minorToDecimal(imbalance, SCALE),
  };
}

/**
 * Aging buckets follow QuickBooks convention:
 *   current   -- not yet due (asOf <= due_date)
 *   1-30      -- 1 to 30 days past due
 *   31-60     -- 31 to 60 days past due
 *   61-90     -- 61 to 90 days past due
 *   over 90   -- more than 90 days past due
 *
 * Only invoices/bills with status IN ('open', 'partial') contribute -- paid
 * docs have balance_due = 0 already, void docs are excluded by status.
 */
export interface AgingRow {
  counterpartyId: string;
  counterpartyName: string;
  current: string;
  days1to30: string;
  days31to60: string;
  days61to90: string;
  days91plus: string;
  total: string;
}

export interface AgingReport {
  asOf: string;
  rows: AgingRow[];
  totals: Omit<AgingRow, 'counterpartyId' | 'counterpartyName'>;
}

export async function arAging(db: Database, asOf: string): Promise<AgingReport> {
  const rows = await db.execute(sql`
    SELECT
      c.id   AS counterparty_id,
      c.display_name AS counterparty_name,
      COALESCE(SUM(CASE WHEN (${asOf}::date - i.due_date) <= 0 THEN i.balance_due ELSE 0 END), 0) AS current,
      COALESCE(SUM(CASE WHEN (${asOf}::date - i.due_date) BETWEEN 1 AND 30 THEN i.balance_due ELSE 0 END), 0) AS days1to30,
      COALESCE(SUM(CASE WHEN (${asOf}::date - i.due_date) BETWEEN 31 AND 60 THEN i.balance_due ELSE 0 END), 0) AS days31to60,
      COALESCE(SUM(CASE WHEN (${asOf}::date - i.due_date) BETWEEN 61 AND 90 THEN i.balance_due ELSE 0 END), 0) AS days61to90,
      COALESCE(SUM(CASE WHEN (${asOf}::date - i.due_date) > 90 THEN i.balance_due ELSE 0 END), 0) AS days91plus,
      COALESCE(SUM(i.balance_due), 0) AS total
    FROM customers c
    INNER JOIN invoices i ON i.customer_id = c.id
    WHERE i.status IN ('open', 'partial')
      AND i.invoice_date <= ${asOf}::date
    GROUP BY c.id, c.display_name
    HAVING COALESCE(SUM(i.balance_due), 0) > 0
    ORDER BY c.display_name
  `);
  return summarise(asOf, rows as unknown as Array<Record<string, unknown>>);
}

export async function apAging(db: Database, asOf: string): Promise<AgingReport> {
  const rows = await db.execute(sql`
    SELECT
      v.id   AS counterparty_id,
      v.display_name AS counterparty_name,
      COALESCE(SUM(CASE WHEN (${asOf}::date - b.due_date) <= 0 THEN b.balance_due ELSE 0 END), 0) AS current,
      COALESCE(SUM(CASE WHEN (${asOf}::date - b.due_date) BETWEEN 1 AND 30 THEN b.balance_due ELSE 0 END), 0) AS days1to30,
      COALESCE(SUM(CASE WHEN (${asOf}::date - b.due_date) BETWEEN 31 AND 60 THEN b.balance_due ELSE 0 END), 0) AS days31to60,
      COALESCE(SUM(CASE WHEN (${asOf}::date - b.due_date) BETWEEN 61 AND 90 THEN b.balance_due ELSE 0 END), 0) AS days61to90,
      COALESCE(SUM(CASE WHEN (${asOf}::date - b.due_date) > 90 THEN b.balance_due ELSE 0 END), 0) AS days91plus,
      COALESCE(SUM(b.balance_due), 0) AS total
    FROM vendors v
    INNER JOIN bills b ON b.vendor_id = v.id
    WHERE b.status IN ('open', 'partial')
      AND b.bill_date <= ${asOf}::date
    GROUP BY v.id, v.display_name
    HAVING COALESCE(SUM(b.balance_due), 0) > 0
    ORDER BY v.display_name
  `);
  return summarise(asOf, rows as unknown as Array<Record<string, unknown>>);
}

function summarise(asOf: string, rows: Array<Record<string, unknown>>): AgingReport {
  const SCALE = 10000n;
  let tCurrent = 0n;
  let t1to30 = 0n;
  let t31to60 = 0n;
  let t61to90 = 0n;
  let t91plus = 0n;
  let tAll = 0n;
  const out: AgingRow[] = rows.map((r) => {
    const row: AgingRow = {
      counterpartyId: String(r.counterparty_id),
      counterpartyName: String(r.counterparty_name),
      current: String(r.current ?? '0'),
      days1to30: String(r.days1to30 ?? '0'),
      days31to60: String(r.days31to60 ?? '0'),
      days61to90: String(r.days61to90 ?? '0'),
      days91plus: String(r.days91plus ?? '0'),
      total: String(r.total ?? '0'),
    };
    tCurrent += decimalToMinor(row.current, SCALE);
    t1to30 += decimalToMinor(row.days1to30, SCALE);
    t31to60 += decimalToMinor(row.days31to60, SCALE);
    t61to90 += decimalToMinor(row.days61to90, SCALE);
    t91plus += decimalToMinor(row.days91plus, SCALE);
    tAll += decimalToMinor(row.total, SCALE);
    return row;
  });
  return {
    asOf,
    rows: out,
    totals: {
      current: minorToDecimal(tCurrent, SCALE),
      days1to30: minorToDecimal(t1to30, SCALE),
      days31to60: minorToDecimal(t31to60, SCALE),
      days61to90: minorToDecimal(t61to90, SCALE),
      days91plus: minorToDecimal(t91plus, SCALE),
      total: minorToDecimal(tAll, SCALE),
    },
  };
}

// ─── 1099-NEC year-end summary ────────────────────────────────────────────

export interface NinetyNineRow {
  vendorId: string;
  displayName: string;
  taxId: string | null;
  mailingAddress: Record<string, unknown> | null;
  /** Total non-voided posted payments (vendor_sent) in the calendar year. */
  total: string;
  /** True when total >= $600 (current IRS 1099-NEC threshold). */
  meetsThreshold: boolean;
  /** True when the vendor is missing the TIN/EIN required for the form. */
  missingTaxId: boolean;
}

export interface NinetyNineReport {
  year: number;
  rows: NinetyNineRow[];
  totals: { total: string; aboveThreshold: number; missingTaxIdAboveThreshold: number };
}

/**
 * 1099-NEC year-end summary. Lists every vendor flagged is_1099_vendor with
 * the sum of posted vendor_sent payments dated within the given calendar
 * year. The CPA uses this to fill 1099-NEC forms in January for the
 * previous tax year. IRS threshold is $600 -- vendors below it are still
 * shown so the user can sanity-check the list, but flagged via
 * meetsThreshold.
 */
export async function nineteenNinetyNineSummary(
  db: Database,
  year: number,
): Promise<NinetyNineReport> {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const rows = await db.execute(sql`
    SELECT
      v.id            AS vendor_id,
      v.display_name  AS display_name,
      v.tax_id        AS tax_id,
      v.mailing_address AS mailing_address,
      COALESCE(
        SUM(CASE WHEN p.status = 'posted' THEN p.amount ELSE 0 END),
        0
      )               AS total
    FROM vendors v
    LEFT JOIN payments p
           ON p.vendor_id = v.id
          AND p.payment_type = 'vendor_sent'
          AND p.payment_date BETWEEN ${start}::date AND ${end}::date
    WHERE v.is_1099_vendor = true
    GROUP BY v.id, v.display_name, v.tax_id, v.mailing_address
    ORDER BY total DESC, v.display_name
  `);

  const SCALE = 10000n;
  let grandTotal = 0n;
  let aboveThreshold = 0;
  let missingAbove = 0;
  const SIX_HUNDRED = 6000000n; // $600.0000 in 4dp micros

  const out: NinetyNineRow[] = (rows as unknown as Array<Record<string, unknown>>).map((r) => {
    const total = String(r.total ?? '0');
    const minor = decimalToMinor(total, SCALE);
    grandTotal += minor;
    const meets = minor >= SIX_HUNDRED;
    const missing = !r.tax_id || String(r.tax_id).trim().length === 0;
    if (meets) aboveThreshold++;
    if (meets && missing) missingAbove++;
    return {
      vendorId: String(r.vendor_id),
      displayName: String(r.display_name),
      taxId: r.tax_id ? String(r.tax_id) : null,
      mailingAddress: (r.mailing_address as Record<string, unknown> | null) ?? null,
      total,
      meetsThreshold: meets,
      missingTaxId: missing,
    };
  });

  return {
    year,
    rows: out,
    totals: {
      total: minorToDecimal(grandTotal, SCALE),
      aboveThreshold,
      missingTaxIdAboveThreshold: missingAbove,
    },
  };
}

// ─── Statement of Cash Flows (indirect method) ────────────────────────────

export interface CashFlowLine {
  accountId: string;
  code: string;
  name: string;
  /** Effect on cash for the period: positive = source of cash, negative = use of cash. */
  amount: string;
}

export interface StatementOfCashFlows {
  start: string;
  end: string;
  /** Net income for the period (from P&L), starts the operating section. */
  netIncome: string;
  /** Working-capital adjustments (changes in AR, AP, etc.). */
  operatingAdjustments: CashFlowLine[];
  /** netIncome + sum(operatingAdjustments). */
  totalOperating: string;
  /** Changes in fixed/other assets. */
  investing: CashFlowLine[];
  totalInvesting: string;
  /** Changes in long-term debt and equity (excluding retained earnings). */
  financing: CashFlowLine[];
  totalFinancing: string;
  /** totalOperating + totalInvesting + totalFinancing. */
  netChange: string;
  /** Sum of bank-subtype account balances at start of period. */
  beginningCash: string;
  /** Sum of bank-subtype account balances at end of period. */
  endingCash: string;
  /** netChange - (endingCash - beginningCash); should be 0.0000 for a balanced period.
   *  Non-zero means direct edits to retained earnings or bank-equity entries that
   *  bypass the indirect-method assumptions. */
  imbalance: string;
}

const SUBTYPE_TO_SCF_SECTION: Record<string, 'operating' | 'investing' | 'financing'> = {
  // current-asset working capital -> operating
  accounts_receivable: 'operating',
  other_current_asset: 'operating',
  // long-lived assets -> investing
  fixed_asset: 'investing',
  other_asset: 'investing',
  // current liabilities -> operating
  accounts_payable: 'operating',
  credit_card: 'operating',
  other_current_liability: 'operating',
  // long-term funding -> financing
  long_term_liability: 'financing',
  equity: 'financing',
  // bank: excluded (this IS cash, the result we're explaining)
  // retained_earnings: excluded (already counted via netIncome)
};

/**
 * Statement of Cash Flows, indirect method. Starts from net income and
 * reconciles to the period change in cash by walking every non-cash balance
 * sheet account's start-vs-end change, signed by normal-balance convention
 * (asset up = cash out; liability/equity up = cash in). Bucketed by subtype.
 *
 * Caveat: depreciation is not separately broken out. In the indirect method
 * it's typically added back in operating, but since this report buckets by
 * subtype, depreciation flows through "fixed_asset" change in investing.
 * The total cash flow is still correct -- only the section attribution
 * differs from a textbook presentation.
 */
export async function statementOfCashFlows(
  db: Database,
  start: string,
  end: string,
): Promise<StatementOfCashFlows> {
  const pl = await profitAndLoss(db, start, end);

  const rows = await db.execute(sql`
    SELECT
      a.id      AS account_id,
      a.code    AS code,
      a.name    AS name,
      a.type    AS type,
      a.subtype AS subtype,
      CASE
        WHEN a.type = 'asset'
          THEN COALESCE(SUM(CASE WHEN je.entry_date <= ${end}::date   THEN jl.debit  ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN je.entry_date <= ${end}::date   THEN jl.credit ELSE 0 END), 0)
        ELSE
             COALESCE(SUM(CASE WHEN je.entry_date <= ${end}::date   THEN jl.credit ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN je.entry_date <= ${end}::date   THEN jl.debit  ELSE 0 END), 0)
      END AS balance_end,
      CASE
        WHEN a.type = 'asset'
          THEN COALESCE(SUM(CASE WHEN je.entry_date <  ${start}::date THEN jl.debit  ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN je.entry_date <  ${start}::date THEN jl.credit ELSE 0 END), 0)
        ELSE
             COALESCE(SUM(CASE WHEN je.entry_date <  ${start}::date THEN jl.credit ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN je.entry_date <  ${start}::date THEN jl.debit  ELSE 0 END), 0)
      END AS balance_start
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.entry_id
    WHERE a.type IN ('asset', 'liability', 'equity')
      AND a.is_active = true
    GROUP BY a.id, a.code, a.name, a.type, a.subtype
    ORDER BY a.code
  `);

  const SCALE = 10000n;
  const operating: CashFlowLine[] = [];
  const investing: CashFlowLine[] = [];
  const financing: CashFlowLine[] = [];
  let beginCash = 0n;
  let endCash = 0n;
  let opAdjTotal = 0n;
  let invTotal = 0n;
  let finTotal = 0n;

  for (const r of rows as unknown as Array<Record<string, unknown>>) {
    const subtype = String(r.subtype);
    const type = String(r.type);
    const balStart = decimalToMinor(String(r.balance_start ?? '0'), SCALE);
    const balEnd = decimalToMinor(String(r.balance_end ?? '0'), SCALE);

    if (subtype === 'bank') {
      beginCash += balStart;
      endCash += balEnd;
      continue;
    }
    if (subtype === 'retained_earnings') continue;

    const change = balEnd - balStart;
    if (change === 0n) continue;
    // Asset up consumes cash; liability/equity up provides cash.
    const cashEffect = type === 'asset' ? -change : change;

    const line: CashFlowLine = {
      accountId: String(r.account_id),
      code: String(r.code),
      name: String(r.name),
      amount: minorToDecimal(cashEffect, SCALE),
    };

    const section = SUBTYPE_TO_SCF_SECTION[subtype] ?? 'operating';
    if (section === 'operating') {
      operating.push(line);
      opAdjTotal += cashEffect;
    } else if (section === 'investing') {
      investing.push(line);
      invTotal += cashEffect;
    } else {
      financing.push(line);
      finTotal += cashEffect;
    }
  }

  const netIncomeMinor = decimalToMinor(pl.netIncome, SCALE);
  const totalOperating = netIncomeMinor + opAdjTotal;
  const netChange = totalOperating + invTotal + finTotal;
  const expectedCashChange = endCash - beginCash;

  return {
    start,
    end,
    netIncome: pl.netIncome,
    operatingAdjustments: operating,
    totalOperating: minorToDecimal(totalOperating, SCALE),
    investing,
    totalInvesting: minorToDecimal(invTotal, SCALE),
    financing,
    totalFinancing: minorToDecimal(finTotal, SCALE),
    netChange: minorToDecimal(netChange, SCALE),
    beginningCash: minorToDecimal(beginCash, SCALE),
    endingCash: minorToDecimal(endCash, SCALE),
    imbalance: minorToDecimal(netChange - expectedCashChange, SCALE),
  };
}

// ─── Payroll register + Workers' comp (Phase B of payroll-tracking) ──────

export interface PayrollRegisterRow {
  vendorId: string;
  displayName: string;
  workerType: 'contractor' | 'employee' | 'subcontractor' | 'not_a_worker';
  taxId: string | null;
  workersCompClass: string | null;
  paySchedule: string | null;
  paymentCount: number;
  totalPaid: string;
}

export interface PayrollRegisterTotals {
  totalPaid: string;
  totalPayments: number;
  byWorkerType: Array<{
    workerType: 'contractor' | 'employee' | 'subcontractor' | 'not_a_worker';
    count: number;
    total: string;
  }>;
}

export interface PayrollRegister {
  from: string;
  to: string;
  rows: PayrollRegisterRow[];
  totals: PayrollRegisterTotals;
}

/**
 * Date-range listing of every active worker (contractor / subcontractor /
 * employee) and what they were paid in non-voided vendor_sent payments
 * during [from, to]. Workers with zero paid in the range are still
 * included so the user sees who they DIDN'T pay this period -- useful
 * for spotting missed paychecks.
 *
 * Optional workerType filter narrows the report to one classification at a
 * time; default returns all three.
 */
export async function payrollRegister(
  db: Database,
  from: string,
  to: string,
  workerType?: 'contractor' | 'employee' | 'subcontractor',
): Promise<PayrollRegister> {
  const rows = await db.execute(sql`
    SELECT
      v.id            AS vendor_id,
      v.display_name  AS display_name,
      v.worker_type   AS worker_type,
      v.tax_id        AS tax_id,
      v.workers_comp_class AS workers_comp_class,
      v.pay_schedule  AS pay_schedule,
      COUNT(p.id) FILTER (WHERE p.id IS NOT NULL) AS payment_count,
      COALESCE(SUM(p.amount) FILTER (WHERE p.id IS NOT NULL), 0) AS total_paid
    FROM vendors v
    LEFT JOIN payments p
           ON p.vendor_id = v.id
          AND p.payment_type = 'vendor_sent'
          AND p.status = 'posted'
          AND p.payment_date BETWEEN ${from}::date AND ${to}::date
    WHERE v.worker_type <> 'not_a_worker'
      AND v.is_active = true
      ${workerType ? sql`AND v.worker_type = ${workerType}` : sql``}
    GROUP BY v.id, v.display_name, v.worker_type, v.tax_id,
             v.workers_comp_class, v.pay_schedule
    ORDER BY total_paid DESC, v.display_name ASC
  `);

  const SCALE = 10000n;
  let totalPaidMinor = 0n;
  let totalPayments = 0;
  const byTypeMap = new Map<
    string,
    { workerType: PayrollRegisterRow['workerType']; count: number; total: bigint }
  >();
  const out: PayrollRegisterRow[] = [];

  for (const r of rows as unknown as Array<Record<string, unknown>>) {
    const wt = r.worker_type as PayrollRegisterRow['workerType'];
    const totalStr = String(r.total_paid ?? '0');
    const minor = decimalToMinor(totalStr, SCALE);
    const count = Number(r.payment_count ?? 0);
    totalPaidMinor += minor;
    totalPayments += count;
    const bucket = byTypeMap.get(wt) ?? { workerType: wt, count: 0, total: 0n };
    bucket.count += count;
    bucket.total += minor;
    byTypeMap.set(wt, bucket);
    out.push({
      vendorId: String(r.vendor_id),
      displayName: String(r.display_name),
      workerType: wt,
      taxId: r.tax_id ? String(r.tax_id) : null,
      workersCompClass: r.workers_comp_class ? String(r.workers_comp_class) : null,
      paySchedule: r.pay_schedule ? String(r.pay_schedule) : null,
      paymentCount: count,
      totalPaid: totalStr,
    });
  }

  return {
    from,
    to,
    rows: out,
    totals: {
      totalPaid: minorToDecimal(totalPaidMinor, SCALE),
      totalPayments,
      byWorkerType: Array.from(byTypeMap.values()).map((b) => ({
        workerType: b.workerType,
        count: b.count,
        total: minorToDecimal(b.total, SCALE),
      })),
    },
  };
}

export interface WorkersCompSummaryRow {
  workersCompClass: string | null;
  workerCount: number;
  totalPaid: string;
}

export interface WorkersCompSummary {
  from: string;
  to: string;
  rows: WorkersCompSummaryRow[];
  totalPaid: string;
}

/**
 * Per-class aggregate of payments to active workers in [from, to].
 * Workers with no class set bucket into a single 'unclassified' row so the
 * bookkeeper can spot them and assign codes. Audit / WC-insurance
 * recertification season is the typical caller.
 */
export async function workersCompSummary(
  db: Database,
  from: string,
  to: string,
): Promise<WorkersCompSummary> {
  const rows = await db.execute(sql`
    SELECT
      v.workers_comp_class AS workers_comp_class,
      COUNT(DISTINCT v.id) AS worker_count,
      COALESCE(SUM(p.amount), 0) AS total_paid
    FROM vendors v
    INNER JOIN payments p
            ON p.vendor_id = v.id
           AND p.payment_type = 'vendor_sent'
           AND p.status = 'posted'
           AND p.payment_date BETWEEN ${from}::date AND ${to}::date
    WHERE v.worker_type <> 'not_a_worker'
      AND v.is_active = true
    GROUP BY v.workers_comp_class
    ORDER BY total_paid DESC NULLS LAST
  `);

  const SCALE = 10000n;
  let grand = 0n;
  const out: WorkersCompSummaryRow[] = (
    rows as unknown as Array<Record<string, unknown>>
  ).map((r) => {
    const totalStr = String(r.total_paid ?? '0');
    grand += decimalToMinor(totalStr, SCALE);
    return {
      workersCompClass: r.workers_comp_class ? String(r.workers_comp_class) : null,
      workerCount: Number(r.worker_count ?? 0),
      totalPaid: totalStr,
    };
  });
  return { from, to, rows: out, totalPaid: minorToDecimal(grand, SCALE) };
}

// ─── Compliance-expiring (Phase A of payroll-tracking slice) ─────────────

export interface ComplianceExpirationRow {
  vendorId: string;
  displayName: string;
  workerType: string;
  /** Which document is expiring; one row per (vendor, doc-type) combo. */
  documentType: 'license' | 'general_liability' | 'workers_comp';
  expirationDate: string;
  daysUntilExpiration: number; // negative = already expired
}

/**
 * Subcontractors whose license / GL insurance / WC insurance expires within
 * `withinDays` of today (or has already expired). Returns one row per
 * (vendor, document-type) combo so the UI can show each missing item
 * separately. Sorted by daysUntilExpiration ascending so the most urgent
 * sits at the top.
 */
export async function complianceExpiring(
  db: Database,
  withinDays: number,
): Promise<ComplianceExpirationRow[]> {
  const days = Math.max(0, Math.min(withinDays, 365));
  const rows = await db.execute(sql`
    WITH expirations AS (
      SELECT
        v.id           AS vendor_id,
        v.display_name AS display_name,
        v.worker_type  AS worker_type,
        'license'      AS document_type,
        v.license_expiration AS expiration_date
      FROM vendors v
      WHERE v.worker_type = 'subcontractor'
        AND v.is_active = true
        AND v.license_expiration IS NOT NULL
        AND (v.license_expiration - CURRENT_DATE) <= ${days}::int
      UNION ALL
      SELECT
        v.id, v.display_name, v.worker_type,
        'general_liability',
        v.insurance_general_liability_expiration
      FROM vendors v
      WHERE v.worker_type = 'subcontractor'
        AND v.is_active = true
        AND v.insurance_general_liability_expiration IS NOT NULL
        AND (v.insurance_general_liability_expiration - CURRENT_DATE) <= ${days}::int
      UNION ALL
      SELECT
        v.id, v.display_name, v.worker_type,
        'workers_comp',
        v.insurance_workers_comp_expiration
      FROM vendors v
      WHERE v.worker_type = 'subcontractor'
        AND v.is_active = true
        AND v.insurance_workers_comp_expiration IS NOT NULL
        AND (v.insurance_workers_comp_expiration - CURRENT_DATE) <= ${days}::int
    )
    SELECT
      vendor_id,
      display_name,
      worker_type,
      document_type,
      expiration_date,
      (expiration_date - CURRENT_DATE) AS days_until_expiration
    FROM expirations
    ORDER BY days_until_expiration ASC, display_name ASC
  `);
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    vendorId: String(r.vendor_id),
    displayName: String(r.display_name),
    workerType: String(r.worker_type),
    documentType: String(r.document_type) as ComplianceExpirationRow['documentType'],
    expirationDate: String(r.expiration_date),
    daysUntilExpiration: Number(r.days_until_expiration ?? 0),
  }));
}

// -- Cash flow forecast (Slice #39) ----------------------------------------

export interface CashAccountRow {
  accountId: string;
  code: string;
  name: string;
  subtype: 'bank' | 'credit_card';
  balance: string;
}

export interface ForecastArDueItem {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  invoiceDate: string;
  dueDate: string;
  balanceDue: string;
}

export interface ForecastApDueItem {
  billId: string;
  billNumber: string;
  vendorId: string;
  vendorName: string;
  billDate: string;
  dueDate: string;
  balanceDue: string;
}

export interface ForecastRecurringOccurrence {
  templateId: string;
  templateName: string;
  /** customer or vendor display name. */
  counterpartyName: string;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annually';
  occurrenceDate: string;
  amount: string;
}

export interface ForecastWeek {
  weekStart: string;
  weekEnd: string;
  openingBalance: string;
  arDue: string;
  recurringInflows: string;
  apDue: string;
  recurringOutflows: string;
  inflows: string;
  outflows: string;
  netChange: string;
  closingBalance: string;
}

export interface CashFlowForecast {
  asOf: string;
  horizonDays: number;
  startingBalance: string;
  cashAccounts: CashAccountRow[];
  weeks: ForecastWeek[];
  arDue: ForecastArDueItem[];
  apDue: ForecastApDueItem[];
  recurringInvoices: ForecastRecurringOccurrence[];
  recurringBills: ForecastRecurringOccurrence[];
  totals: {
    arDue: string;
    apDue: string;
    recurringInflows: string;
    recurringOutflows: string;
    inflows: string;
    outflows: string;
    netChange: string;
    endingBalance: string;
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysIso(base: string, days: number): string {
  const d = new Date(base + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function addMonthsIso(base: string, months: number, dayOfMonthHint: number | null): string {
  // dayOfMonthHint=31 means "last day of month". Otherwise we clamp to the
  // requested day, falling back to the last day of the target month.
  const [y, m] = base.split('-').map((v) => Number(v));
  const target = new Date(Date.UTC(y!, m! - 1 + months, 1));
  // Days in target month: day 0 of next month.
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const desiredDay = dayOfMonthHint && dayOfMonthHint > 0 ? dayOfMonthHint : Number(base.slice(8, 10));
  const day = desiredDay >= 31 ? lastDay : Math.min(desiredDay, lastDay);
  target.setUTCDate(day);
  return isoDate(target);
}

function nextOccurrenceDate(
  prev: string,
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annually',
  dayOfMonthHint: number | null,
): string {
  switch (frequency) {
    case 'weekly':
      return addDaysIso(prev, 7);
    case 'biweekly':
      return addDaysIso(prev, 14);
    case 'monthly':
      return addMonthsIso(prev, 1, dayOfMonthHint);
    case 'quarterly':
      return addMonthsIso(prev, 3, dayOfMonthHint);
    case 'annually':
      return addMonthsIso(prev, 12, dayOfMonthHint);
  }
}

/**
 * Cash flow forecast for the next `horizonDays` days. Combines:
 *   - current cash balance (bank + credit_card subtype accounts)
 *   - open invoices with due_date in window (expected inflows)
 *   - open bills with due_date in window (expected outflows)
 *   - active recurring templates that will fire in the window
 *
 * Bucketed into 7-day windows starting from `asOf`, so week 1 is days 0-6,
 * week 2 is days 7-13, etc. Each week shows opening balance, in/outflows,
 * and projected closing balance. Drill-down arrays return individual
 * invoices, bills, and recurring occurrences for the UI.
 *
 * Tax on recurring is intentionally ignored -- a forecast is approximate by
 * nature and the line subtotals (qty × unitPrice) are accurate enough for
 * cash planning. Tax becomes part of the actual JE when the recurring
 * template fires.
 */
export async function cashFlowForecast(
  db: Database,
  asOf: string,
  horizonDays: number,
): Promise<CashFlowForecast> {
  const horizon = Math.max(7, Math.min(horizonDays, 365));
  const horizonEnd = addDaysIso(asOf, horizon);

  // Step 1: cash account balances as of `asOf`. Bank + credit-card subtypes
  // are the cash-equivalent accounts; balance = SUM(debit) - SUM(credit) per
  // normal-balance convention (asset = debit-positive).
  const cashRows = await db.execute(sql`
    SELECT
      a.id      AS account_id,
      a.code    AS code,
      a.name    AS name,
      a.subtype AS subtype,
      COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS balance
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je
           ON je.id = jl.entry_id
          AND je.entry_date <= ${asOf}::date
    WHERE a.subtype IN ('bank', 'credit_card')
      AND a.is_active = true
    GROUP BY a.id, a.code, a.name, a.subtype
    ORDER BY a.code
  `);

  const SCALE = 10000n;
  const cashAccounts: CashAccountRow[] = [];
  let startingMinor = 0n;
  for (const r of cashRows as unknown as Array<Record<string, unknown>>) {
    const balance = String(r.balance ?? '0');
    cashAccounts.push({
      accountId: String(r.account_id),
      code: String(r.code),
      name: String(r.name),
      subtype: r.subtype as 'bank' | 'credit_card',
      balance,
    });
    startingMinor += decimalToMinor(balance, SCALE);
  }

  // Step 2: AR due in window (open invoices, due_date in [asOf, asOf+horizon]).
  const arRows = await db.execute(sql`
    SELECT
      i.id              AS invoice_id,
      i.invoice_number  AS invoice_number,
      i.customer_id     AS customer_id,
      c.display_name    AS customer_name,
      i.invoice_date    AS invoice_date,
      i.due_date        AS due_date,
      i.balance_due     AS balance_due
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status IN ('open', 'partial')
      AND i.due_date BETWEEN ${asOf}::date AND ${horizonEnd}::date
      AND i.balance_due > 0
    ORDER BY i.due_date ASC, i.invoice_number ASC
  `);
  const arDue: ForecastArDueItem[] = (arRows as unknown as Array<Record<string, unknown>>).map(
    (r) => ({
      invoiceId: String(r.invoice_id),
      invoiceNumber: String(r.invoice_number),
      customerId: String(r.customer_id),
      customerName: String(r.customer_name),
      invoiceDate: String(r.invoice_date),
      dueDate: String(r.due_date),
      balanceDue: String(r.balance_due),
    }),
  );

  // Step 3: AP due in window.
  const apRows = await db.execute(sql`
    SELECT
      b.id              AS bill_id,
      b.bill_number     AS bill_number,
      b.vendor_id       AS vendor_id,
      v.display_name    AS vendor_name,
      b.bill_date       AS bill_date,
      b.due_date        AS due_date,
      b.balance_due     AS balance_due
    FROM bills b
    JOIN vendors v ON v.id = b.vendor_id
    WHERE b.status IN ('open', 'partial')
      AND b.due_date BETWEEN ${asOf}::date AND ${horizonEnd}::date
      AND b.balance_due > 0
    ORDER BY b.due_date ASC, b.bill_number ASC
  `);
  const apDue: ForecastApDueItem[] = (apRows as unknown as Array<Record<string, unknown>>).map(
    (r) => ({
      billId: String(r.bill_id),
      billNumber: String(r.bill_number),
      vendorId: String(r.vendor_id),
      vendorName: String(r.vendor_name),
      billDate: String(r.bill_date),
      dueDate: String(r.due_date),
      balanceDue: String(r.balance_due),
    }),
  );

  // Step 4: active recurring templates that COULD fire in the window. Filter
  // server-side on next_run_date <= horizonEnd; we expand occurrences in JS.
  const tmplRows = await db.execute(sql`
    SELECT
      rt.id            AS template_id,
      rt.name          AS template_name,
      rt.kind          AS kind,
      rt.frequency     AS frequency,
      rt.day_of_month  AS day_of_month,
      rt.next_run_date AS next_run_date,
      rt.end_date      AS end_date,
      rt.payload       AS payload,
      COALESCE(c.display_name, v.display_name) AS counterparty_name
    FROM recurring_templates rt
    LEFT JOIN customers c ON c.id::text = (rt.payload->>'customerId') AND rt.kind = 'invoice'
    LEFT JOIN vendors   v ON v.id::text = (rt.payload->>'vendorId')   AND rt.kind = 'bill'
    WHERE rt.is_active = true
      AND rt.next_run_date <= ${horizonEnd}::date
  `);

  const recurringInvoices: ForecastRecurringOccurrence[] = [];
  const recurringBills: ForecastRecurringOccurrence[] = [];
  for (const r of tmplRows as unknown as Array<Record<string, unknown>>) {
    const payload = r.payload as { lines?: Array<{ quantity?: unknown; unitPrice?: unknown }> } | null;
    const lines = payload?.lines ?? [];
    let subtotalMinor = 0n;
    for (const l of lines) {
      const qty = Number(l.quantity ?? 1);
      const price = Number(l.unitPrice ?? 0);
      if (Number.isFinite(qty) && Number.isFinite(price)) {
        // Convert qty*price to minor units carefully: keep 4 decimal places.
        const product = qty * price;
        subtotalMinor += decimalToMinor(product.toFixed(4), SCALE);
      }
    }
    if (subtotalMinor <= 0n) continue;
    const amount = minorToDecimal(subtotalMinor, SCALE);

    const frequency = r.frequency as ForecastRecurringOccurrence['frequency'];
    const dayOfMonth = r.day_of_month === null || r.day_of_month === undefined
      ? null
      : Number(r.day_of_month);
    const endDate = r.end_date ? String(r.end_date) : null;
    let cursor = String(r.next_run_date);
    // Cap at the soonest of: horizonEnd, end_date.
    const stopAt = endDate && endDate < horizonEnd ? endDate : horizonEnd;
    let safety = 0;
    while (cursor <= stopAt && safety < 366) {
      // Drop occurrences before asOf -- a stale next_run_date shouldn't double-count.
      if (cursor >= asOf) {
        const occ: ForecastRecurringOccurrence = {
          templateId: String(r.template_id),
          templateName: String(r.template_name),
          counterpartyName: r.counterparty_name ? String(r.counterparty_name) : '—',
          frequency,
          occurrenceDate: cursor,
          amount,
        };
        if (r.kind === 'invoice') recurringInvoices.push(occ);
        else recurringBills.push(occ);
      }
      cursor = nextOccurrenceDate(cursor, frequency, dayOfMonth);
      safety++;
    }
  }

  // Step 5: bucket into weekly windows from asOf. Week N covers days
  // [asOf+7N, asOf+7N+6]. Pre-compute number of buckets to fit horizon.
  const weekCount = Math.ceil(horizon / 7);
  const buckets: Array<{
    weekStart: string;
    weekEnd: string;
    arMinor: bigint;
    recurringInMinor: bigint;
    apMinor: bigint;
    recurringOutMinor: bigint;
  }> = [];
  for (let i = 0; i < weekCount; i++) {
    const start = addDaysIso(asOf, i * 7);
    const end = addDaysIso(asOf, Math.min(i * 7 + 6, horizon - 1));
    buckets.push({
      weekStart: start,
      weekEnd: end,
      arMinor: 0n,
      recurringInMinor: 0n,
      apMinor: 0n,
      recurringOutMinor: 0n,
    });
  }
  const bucketIndex = (date: string): number => {
    if (date < asOf) return -1;
    const dayOffset = Math.floor(
      (Date.UTC(...isoToUtcArgs(date)) - Date.UTC(...isoToUtcArgs(asOf))) /
        (24 * 60 * 60 * 1000),
    );
    if (dayOffset >= horizon) return -1;
    return Math.floor(dayOffset / 7);
  };

  for (const it of arDue) {
    const idx = bucketIndex(it.dueDate);
    if (idx >= 0) buckets[idx]!.arMinor += decimalToMinor(it.balanceDue, SCALE);
  }
  for (const it of apDue) {
    const idx = bucketIndex(it.dueDate);
    if (idx >= 0) buckets[idx]!.apMinor += decimalToMinor(it.balanceDue, SCALE);
  }
  for (const it of recurringInvoices) {
    const idx = bucketIndex(it.occurrenceDate);
    if (idx >= 0) buckets[idx]!.recurringInMinor += decimalToMinor(it.amount, SCALE);
  }
  for (const it of recurringBills) {
    const idx = bucketIndex(it.occurrenceDate);
    if (idx >= 0) buckets[idx]!.recurringOutMinor += decimalToMinor(it.amount, SCALE);
  }

  // Step 6: roll opening / closing balance through the buckets.
  const weeks: ForecastWeek[] = [];
  let runningMinor = startingMinor;
  let totArMinor = 0n;
  let totApMinor = 0n;
  let totRecInMinor = 0n;
  let totRecOutMinor = 0n;
  for (const b of buckets) {
    const inflowsMinor = b.arMinor + b.recurringInMinor;
    const outflowsMinor = b.apMinor + b.recurringOutMinor;
    const netMinor = inflowsMinor - outflowsMinor;
    const opening = runningMinor;
    const closing = opening + netMinor;
    weeks.push({
      weekStart: b.weekStart,
      weekEnd: b.weekEnd,
      openingBalance: minorToDecimal(opening, SCALE),
      arDue: minorToDecimal(b.arMinor, SCALE),
      recurringInflows: minorToDecimal(b.recurringInMinor, SCALE),
      apDue: minorToDecimal(b.apMinor, SCALE),
      recurringOutflows: minorToDecimal(b.recurringOutMinor, SCALE),
      inflows: minorToDecimal(inflowsMinor, SCALE),
      outflows: minorToDecimal(outflowsMinor, SCALE),
      netChange: minorToDecimal(netMinor, SCALE),
      closingBalance: minorToDecimal(closing, SCALE),
    });
    runningMinor = closing;
    totArMinor += b.arMinor;
    totApMinor += b.apMinor;
    totRecInMinor += b.recurringInMinor;
    totRecOutMinor += b.recurringOutMinor;
  }
  const totInflowsMinor = totArMinor + totRecInMinor;
  const totOutflowsMinor = totApMinor + totRecOutMinor;
  const totNetMinor = totInflowsMinor - totOutflowsMinor;

  return {
    asOf,
    horizonDays: horizon,
    startingBalance: minorToDecimal(startingMinor, SCALE),
    cashAccounts,
    weeks,
    arDue,
    apDue,
    recurringInvoices,
    recurringBills,
    totals: {
      arDue: minorToDecimal(totArMinor, SCALE),
      apDue: minorToDecimal(totApMinor, SCALE),
      recurringInflows: minorToDecimal(totRecInMinor, SCALE),
      recurringOutflows: minorToDecimal(totRecOutMinor, SCALE),
      inflows: minorToDecimal(totInflowsMinor, SCALE),
      outflows: minorToDecimal(totOutflowsMinor, SCALE),
      netChange: minorToDecimal(totNetMinor, SCALE),
      endingBalance: minorToDecimal(startingMinor + totNetMinor, SCALE),
    },
  };
}

function isoToUtcArgs(d: string): [number, number, number] {
  const [y, m, day] = d.split('-').map((v) => Number(v));
  return [y!, m! - 1, day!];
}

// -- Sales tax liability ----------------------------------------------------

export interface SalesTaxLiabilityRateRow {
  taxRateId: string;
  name: string;
  ratePercent: string;
  isActive: boolean;
  invoiceCount: number;
  taxableSales: string;
  taxCollected: string;
}

export interface SalesTaxLiability {
  from: string;
  to: string;
  /** The "Sales Tax Payable" GL account, if it exists. Null if not yet seeded. */
  account: { id: string; code: string; name: string } | null;
  /** Sum of credits to Sales Tax Payable in [from, to] -- tax accrued in period. */
  collected: string;
  /** Sum of debits to Sales Tax Payable in [from, to] -- remittances + adjustments. */
  remitted: string;
  /** collected - remitted. Positive = liability grew this period. */
  netChange: string;
  /** Cumulative balance of Sales Tax Payable as of `to` -- what you owe today. */
  endingBalance: string;
  /** Per-rate breakdown sourced from non-void invoices billed in [from, to]. */
  byRate: SalesTaxLiabilityRateRow[];
  /**
   * Tax collected via posted invoices that have NO tax_rate_id (legacy / manual
   * tax adjustments). Surfaces as a single "untracked" row so totals reconcile
   * to the GL.
   */
  untracked: { invoiceCount: number; taxCollected: string };
}

/**
 * Sales tax liability report. Combines GL-derived figures (the source of
 * truth for what's owed) with an invoice-level breakdown by rate so the
 * bookkeeper can fill remittance forms per jurisdiction.
 *
 * GL figures use journal_lines against the seeded "Sales Tax Payable"
 * account (matched by exact name + active, same lookup invoices/posting
 * uses on the write side). If the account isn't seeded yet, the GL
 * figures are 0 but the per-rate breakdown still works -- so the report
 * is useful even before the account has any history.
 */
export async function salesTaxLiability(
  db: Database,
  from: string,
  to: string,
): Promise<SalesTaxLiability> {
  // Step 1: locate the Sales Tax Payable account (RLS scopes to current company).
  const stpRows = await db.execute(sql`
    SELECT a.id, a.code, a.name
    FROM accounts a
    WHERE a.name = 'Sales Tax Payable'
      AND a.is_active = true
    ORDER BY a.code
    LIMIT 1
  `);
  const stp = (stpRows as unknown as Array<Record<string, unknown>>)[0] ?? null;
  const account = stp
    ? { id: String(stp.id), code: String(stp.code), name: String(stp.name) }
    : null;

  // Step 2: GL aggregates (period collected/remitted + cumulative ending).
  let collected = '0';
  let remitted = '0';
  let endingBalance = '0';
  if (account) {
    const periodRows = await db.execute(sql`
      SELECT
        COALESCE(SUM(jl.credit), 0) AS credits,
        COALESCE(SUM(jl.debit), 0)  AS debits
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_id = ${account.id}::uuid
        AND je.entry_date BETWEEN ${from}::date AND ${to}::date
    `);
    const p = (periodRows as unknown as Array<Record<string, unknown>>)[0];
    collected = String(p?.credits ?? '0');
    remitted = String(p?.debits ?? '0');

    const cumRows = await db.execute(sql`
      SELECT
        COALESCE(SUM(jl.credit), 0) - COALESCE(SUM(jl.debit), 0) AS balance
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_id = ${account.id}::uuid
        AND je.entry_date <= ${to}::date
    `);
    const c = (cumRows as unknown as Array<Record<string, unknown>>)[0];
    endingBalance = String(c?.balance ?? '0');
  }

  // Step 3: per-rate breakdown from invoices in period (non-void only). The
  // taxable_sales sub-select sums ONLY taxable lines per invoice, matching the
  // base the posting service used to compute tax_amount in the first place.
  const rateRows = await db.execute(sql`
    WITH invoice_in_period AS (
      SELECT
        i.id,
        i.tax_rate_id,
        i.tax_amount,
        COALESCE((
          SELECT SUM(il.amount)
          FROM invoice_lines il
          WHERE il.invoice_id = i.id AND il.taxable = true
        ), 0) AS taxable_sales
      FROM invoices i
      WHERE i.invoice_date BETWEEN ${from}::date AND ${to}::date
        AND i.status <> 'void'
    )
    SELECT
      tr.id           AS tax_rate_id,
      tr.name         AS name,
      tr.rate_percent AS rate_percent,
      tr.is_active    AS is_active,
      COUNT(iip.id)   AS invoice_count,
      COALESCE(SUM(iip.taxable_sales), 0) AS taxable_sales,
      COALESCE(SUM(iip.tax_amount), 0)    AS tax_collected
    FROM tax_rates tr
    LEFT JOIN invoice_in_period iip ON iip.tax_rate_id = tr.id
    GROUP BY tr.id, tr.name, tr.rate_percent, tr.is_active
    HAVING COUNT(iip.id) > 0 OR tr.is_active = true
    ORDER BY tr.is_active DESC, tr.name ASC
  `);
  const byRate: SalesTaxLiabilityRateRow[] = (
    rateRows as unknown as Array<Record<string, unknown>>
  ).map((r) => ({
    taxRateId: String(r.tax_rate_id),
    name: String(r.name),
    ratePercent: String(r.rate_percent),
    isActive: Boolean(r.is_active),
    invoiceCount: Number(r.invoice_count ?? 0),
    taxableSales: String(r.taxable_sales ?? '0'),
    taxCollected: String(r.tax_collected ?? '0'),
  }));

  // Step 4: untracked tax (invoices with tax > 0 but no tax_rate_id). Should be
  // rare but the report surfaces them so totals reconcile to the GL even when
  // legacy data has tax without a linked rate.
  const untrackedRows = await db.execute(sql`
    SELECT
      COUNT(*) AS invoice_count,
      COALESCE(SUM(i.tax_amount), 0) AS tax_collected
    FROM invoices i
    WHERE i.invoice_date BETWEEN ${from}::date AND ${to}::date
      AND i.status <> 'void'
      AND i.tax_rate_id IS NULL
      AND i.tax_amount > 0
  `);
  const u = (untrackedRows as unknown as Array<Record<string, unknown>>)[0];

  // netChange = collected - remitted, computed in minor units to avoid string
  // arithmetic surprises on the wire.
  const SCALE = 10000n;
  const netChange = minorToDecimal(
    decimalToMinor(collected, SCALE) - decimalToMinor(remitted, SCALE),
    SCALE,
  );

  return {
    from,
    to,
    account,
    collected,
    remitted,
    netChange,
    endingBalance,
    byRate,
    untracked: {
      invoiceCount: Number(u?.invoice_count ?? 0),
      taxCollected: String(u?.tax_collected ?? '0'),
    },
  };
}

// Local minor-unit helpers — bigint arithmetic avoids float traps without pulling Decimal into report wiring.
function decimalToMinor(s: string, scale: bigint): bigint {
  const [sign, rest] = s.startsWith('-') ? [-1n, s.slice(1)] : [1n, s];
  const [intPart = '0', fracPartRaw = ''] = rest.split('.');
  const places = Number(scale.toString().length - 1);
  const fracPart = (fracPartRaw + '0'.repeat(places)).slice(0, places);
  return sign * (BigInt(intPart) * scale + BigInt(fracPart || '0'));
}

function minorToDecimal(minor: bigint, scale: bigint): string {
  const sign = minor < 0n ? '-' : '';
  const abs = minor < 0n ? -minor : minor;
  const intPart = abs / scale;
  const fracPart = abs % scale;
  const places = Number(scale.toString().length - 1);
  return `${sign}${intPart.toString()}.${fracPart.toString().padStart(places, '0')}`;
}
