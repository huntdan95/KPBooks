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
