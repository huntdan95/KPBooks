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
