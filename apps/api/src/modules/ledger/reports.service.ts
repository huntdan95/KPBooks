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
  /**
   * Cash basis only (absent on accrual, which keeps that payload byte-identical).
   *
   * The revenue/expense that cash basis could NOT recognise and that no future
   * payment will ever recover. Three conditions all have to hold for an amount
   * to land here:
   *
   *   1. it sits on a journal entry that also touches A/R or A/P;
   *   2. that entry has NO subledger document behind it — no invoices/bills row
   *      resolves from its source_type/source_id. That is IIF-imported GL (the
   *      importer writes journal entries but no invoices, bills or payment
   *      applications — see modules/imports/iif.ts) and hand-written journal
   *      entries against A/R or A/P;
   *   3. the amount was not funded by cash inside that same entry — the part
   *      that was IS recognised above (see cashBasisEntryRecognisableAmount).
   *
   * A natively keyed invoice or bill never appears here: it has a document
   * behind it and its revenue is recognised through payment_applications as its
   * payments land. Only the genuinely unrecoverable gap is disclosed, so the
   * figure means "this much income/expense is missing from the report", not
   * "this much A/R activity exists".
   *
   * Both figures are natural-sign (revenue credit-positive, expense
   * debit-positive), rounded to whole cents, and are NOT included in
   * totalRevenue/totalExpenses.
   */
  unlinkedAccrualActivity?: { revenue: string; expenses: string };
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
      COALESCE(SUM(CASE WHEN je.entry_date <= ${asOf}::date THEN jl.debit  ELSE 0 END), 0) AS debit,
      COALESCE(SUM(CASE WHEN je.entry_date <= ${asOf}::date THEN jl.credit ELSE 0 END), 0) AS credit,
      CASE
        WHEN a.type IN ('asset', 'expense')
          THEN COALESCE(SUM(CASE WHEN je.entry_date <= ${asOf}::date THEN jl.debit  ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN je.entry_date <= ${asOf}::date THEN jl.credit ELSE 0 END), 0)
        ELSE COALESCE(SUM(CASE WHEN je.entry_date <= ${asOf}::date THEN jl.credit ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN je.entry_date <= ${asOf}::date THEN jl.debit  ELSE 0 END), 0)
      END AS balance
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.entry_id
    -- The date predicate must live inside the aggregates (CASE), NOT in the
    -- LEFT JOIN's ON clause: with it on the join, unmatched je rows still
    -- leave jl in the result set and SUM(jl.debit) silently sums ALL TIME.
    WHERE a.is_active = true
    GROUP BY a.id, a.code, a.name, a.type, a.subtype
    HAVING COALESCE(SUM(CASE WHEN je.entry_date <= ${asOf}::date THEN jl.debit  ELSE 0 END), 0) <> 0
        OR COALESCE(SUM(CASE WHEN je.entry_date <= ${asOf}::date THEN jl.credit ELSE 0 END), 0) <> 0
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
  // Cash basis takes a completely different path: recognition follows the
  // money, not the document. See the block comment above cashBasisProfitAndLoss.
  if (basis === 'cash') {
    return cashBasisProfitAndLoss(db, start, end);
  }

  const rows = await db.execute(sql`
    SELECT
      a.id      AS account_id,
      a.code    AS code,
      a.name    AS name,
      a.type    AS type,
      CASE
        WHEN a.type = 'revenue'
          THEN COALESCE(SUM(CASE WHEN je.entry_date BETWEEN ${start}::date AND ${end}::date THEN jl.credit ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN je.entry_date BETWEEN ${start}::date AND ${end}::date THEN jl.debit  ELSE 0 END), 0)
        WHEN a.type = 'expense'
          THEN COALESCE(SUM(CASE WHEN je.entry_date BETWEEN ${start}::date AND ${end}::date THEN jl.debit  ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN je.entry_date BETWEEN ${start}::date AND ${end}::date THEN jl.credit ELSE 0 END), 0)
      END AS amount
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.entry_id
    -- Date predicate inside the aggregates, not on the LEFT JOIN — see trialBalance.
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

// ─── Cash-basis P&L ──────────────────────────────────────────────────────

/**
 * CASH-BASIS RECOGNITION — the approach.
 *
 * Cash basis recognises revenue when cash is RECEIVED and expense when cash is
 * PAID. KPBooks holds three kinds of activity and each needs its own rule:
 *
 *  1. Direct activity — a check written straight to an expense account, a
 *     deposit straight to income, a manual journal entry between accounts that
 *     are neither A/R nor A/P. The entry date IS the cash date, so cash and
 *     accrual agree; we read these off the GL the same way the accrual query
 *     does.
 *
 *  2. A/R and A/P documents — invoices and bills. Their document date is an
 *     accrual date and must never drive recognition. Instead we walk the
 *     payment_applications allocation table (payments link to invoices/bills
 *     through it, never by direct FK): each non-void payment applied to a
 *     non-void document recognises a pro-rata slice of that document's lines,
 *     dated on the PAYMENT date. Unpaid documents — and the unpaid portion of a
 *     partly paid one — never appear at all. Voiding a payment removes its
 *     slice outright: we recompute from live rows every run, so a void leaves
 *     no phantom recognition behind.
 *
 *  3. Accrual activity that cannot be tied to cash — the part of a
 *     revenue/expense line on an A/R- or A/P-touching entry that no cash in
 *     that entry funded. Recognising it would mean recognising on the document
 *     date, which is accrual. It is excluded; and where no subledger document
 *     sits behind the entry (so no future payment can ever recover it) it is
 *     reported in `unlinkedAccrualActivity` so the preparer sees the gap
 *     instead of a silently under-reported income number.
 *
 * Bucket 1 and bucket 3 are NOT separated by a per-entry yes/no test. A single
 * entry routinely contains both: a receipt banked net of the processor's fee
 * (DR bank 970 / DR merchant fees 30 / CR A/R 1,000) settles a receivable AND
 * pays an expense in cash, and an early-pay discount (DR A/P 1,000 / CR bank
 * 980 / CR discounts 20) does the mirror image on the A/P side. Splitting per
 * ENTRY drops that cash-side line out of the report entirely. So each P&L line
 * is split per LINE, by what it is offset against — see
 * cashBasisEntryRecognisableAmount, which is where the rule lives and is unit
 * tested.
 *
 * Date range: `start`/`end` filter the RECOGNITION date — the payment date for
 * anything derived from A/R or A/P, the entry date otherwise.
 *
 * Row set: the same active revenue/expense accounts, in the same `code` order,
 * that the accrual report returns, so the two bases render identically.
 *
 * Rounding: every figure this report emits is a whole number of cents. The
 * per-line pro rata inside a payment runs at the ledger's ten-thousandth scale
 * (that is what keeps a split summing exactly to the payment), but a P&L whose
 * line items do not foot to its own printed total is a defect on a report that
 * gets transcribed onto a tax return — so each account is rounded once, and the
 * totals are the sum of the ROUNDED lines.
 *
 * The allocation math is pure and lives in allocatePaymentAcrossLines /
 * recognizeCashBasisDocument / recognizeCashBasisTotals /
 * cashBasisEntryRecognisableAmount below, so it is unit tested without a
 * database in apps/api/test/cash-basis.test.ts.
 */

/** Which way a document's lines hit the GL. Invoices credit, bills debit. */
export type CashBasisSide = 'credit' | 'debit';

export interface CashBasisLine {
  accountId: string;
  /** Non-negative decimal string — the amount this line posts to the GL. */
  amount: string;
}

export interface CashBasisPayment {
  paymentId: string;
  /** The date the cash moved. This, and only this, is the recognition date. */
  date: string;
  /** The portion of the payment applied to THIS document. */
  amount: string;
  voided?: boolean;
}

export interface CashBasisDocument {
  documentId: string;
  side: CashBasisSide;
  /** Gross total the payments were applied against: subtotal + tax. */
  total: string;
  /** In line_number order. */
  lines: readonly CashBasisLine[];
  /** Applications against this document only. */
  payments: readonly CashBasisPayment[];
  voided?: boolean;
}

export interface CashBasisRecognition {
  accountId: string;
  paymentId: string;
  /** Payment date — cash basis recognises here, never on the document date. */
  date: string;
  /** Credit-positive, exactly like SUM(credit - debit) over journal lines. */
  amount: string;
}

export interface CashBasisAllocation {
  /** One entry per input line, in input order. */
  lines: string[];
  /** The share of the payment that maps to no line: sales tax, plus any overpayment. */
  residual: string;
}

/**
 * Split ONE payment across ONE document's lines, pro rata by line amount.
 *
 * All arithmetic is BigInt in minor units at the ledger's NUMERIC(19,4) scale —
 * no JS float ever touches money. The parts always add back up exactly:
 *
 *     sum(result.lines) + result.residual === paymentAmount
 *
 * Proration is against the document's GROSS total rather than the sum of its
 * lines, because the gross total is what the payment was applied to. The
 * difference between the two — sales tax, which credits a liability account and
 * has no revenue line — rides along as one extra participant and comes back as
 * `residual`, so the tax share of a payment can never be mistaken for revenue.
 *
 * Truncating each share leaves a remainder of at most (participants - 1) minor
 * units. The whole remainder goes on the largest participant; the first of a tie
 * wins, and lines arrive in line_number order, so the split is deterministic.
 * A cent is never dropped and never counted twice.
 *
 * A payment larger than the document (an overpayment, i.e. a customer deposit)
 * recognises at most the document's worth; the excess lands in `residual`,
 * because a deposit is a balance-sheet item and not income.
 */
export function allocatePaymentAcrossLines(
  documentTotal: string,
  lines: readonly CashBasisLine[],
  paymentAmount: string,
): CashBasisAllocation {
  const SCALE = 10000n;
  const paymentMinor = decimalToMinor(paymentAmount, SCALE);
  const lineMinors = lines.map((l) => decimalToMinor(l.amount, SCALE));
  const lineSum = lineMinors.reduce((acc, m) => acc + m, 0n);
  const totalMinor = decimalToMinor(documentTotal, SCALE);
  // Denominator is the gross total, but never less than the lines themselves:
  // if bad data made the lines exceed the total we must still not recognise
  // more than what actually posted.
  const denom = totalMinor > lineSum ? totalMinor : lineSum;

  if (denom <= 0n || paymentMinor <= 0n) {
    return {
      lines: lineMinors.map(() => minorToDecimal(0n, SCALE)),
      residual: minorToDecimal(paymentMinor, SCALE),
    };
  }

  const basis = paymentMinor < denom ? paymentMinor : denom;
  // The trailing participant is the non-line part of the total (sales tax).
  const participants = [...lineMinors, denom - lineSum];
  const shares = participants.map((p) => (p * basis) / denom);
  const assigned = shares.reduce((acc, s) => acc + s, 0n);

  // Largest participant first, ties broken by position (lines arrive in
  // line_number order), so the whole remainder lands on the largest line. It
  // cascades to the next largest only if a participant would otherwise be
  // pushed past its own amount — reachable only for sub-cent payments, but
  // recognising more than a line actually posted is never acceptable.
  const largestFirst = participants
    .map((amount, index) => ({ amount, index }))
    .sort((a, b) => (a.amount === b.amount ? a.index - b.index : a.amount > b.amount ? -1 : 1));
  let remainder = basis - assigned;
  for (const p of largestFirst) {
    if (remainder <= 0n) break;
    const room = participants[p.index]! - shares[p.index]!;
    if (room <= 0n) continue;
    const take = remainder < room ? remainder : room;
    shares[p.index] = shares[p.index]! + take;
    remainder -= take;
  }

  return {
    lines: lineMinors.map((_, i) => minorToDecimal(shares[i]!, SCALE)),
    residual: minorToDecimal(shares[participants.length - 1]! + (paymentMinor - basis), SCALE),
  };
}

/** Deterministic payment order: date first, then id to break same-day ties. */
function byDateThenPaymentId(a: CashBasisPayment, b: CashBasisPayment): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.paymentId !== b.paymentId) return a.paymentId < b.paymentId ? -1 : 1;
  return 0;
}

/**
 * Every recognition event a single document produces, one per (payment, line).
 * A voided document produces none; voided payments are skipped.
 *
 * Allocation is CUMULATIVE, not per payment: each payment re-splits the
 * payments-to-date against the document and recognises the DIFFERENCE from what
 * the earlier payments already recognised. Allocating every payment
 * independently makes each payment sum exactly to itself but lets the smaller
 * lines truncate downward on every instalment while the largest line absorbs
 * the remainder, so a fully paid document never converges on its own line
 * amounts — 100.00 of labour collected in three instalments recognises 99.9999,
 * which a cent-level report then shows a full cent light. Cumulative allocation
 * removes the drift: at the last payment the basis equals the denominator, so
 * every line lands on exactly its own amount.
 *
 * The deltas stay non-negative because each line's cumulative share is
 * monotonic in the amount paid to date — the raw pro rata share is, and the
 * remainder rides on the largest participant, whose rank never changes (it is
 * derived from the fixed line amounts).
 *
 * Amounts are credit-positive: an invoice line recognises +, a bill line −, and
 * a bill line pointed at a revenue account correctly reduces revenue.
 */
export function recognizeCashBasisDocument(doc: CashBasisDocument): CashBasisRecognition[] {
  const SCALE = 10000n;
  if (doc.voided === true) return [];

  const sign = doc.side === 'credit' ? 1n : -1n;
  const live = doc.payments.filter((p) => p.voided !== true).slice().sort(byDateThenPaymentId);

  const out: CashBasisRecognition[] = [];
  const recognised = doc.lines.map(() => 0n);
  let paidToDate = 0n;

  for (const payment of live) {
    paidToDate += decimalToMinor(payment.amount, SCALE);
    const alloc = allocatePaymentAcrossLines(
      doc.total,
      doc.lines,
      minorToDecimal(paidToDate, SCALE),
    );
    for (let i = 0; i < doc.lines.length; i += 1) {
      const cumulative = decimalToMinor(alloc.lines[i]!, SCALE);
      const minor = cumulative - recognised[i]!;
      recognised[i] = cumulative;
      if (minor === 0n) continue;
      out.push({
        accountId: doc.lines[i]!.accountId,
        paymentId: payment.paymentId,
        date: payment.date,
        amount: minorToDecimal(sign * minor, SCALE),
      });
    }
  }
  return out;
}

/**
 * Per-account cash-basis recognition across a set of documents, credit-positive
 * and sorted by accountId. `window` filters on the recognition (payment) date,
 * inclusive on both ends; omit it when the caller already filtered in SQL.
 */
export function recognizeCashBasisTotals(
  docs: readonly CashBasisDocument[],
  window?: { start: string; end: string },
): Array<{ accountId: string; amount: string }> {
  const SCALE = 10000n;
  const byAccount = new Map<string, bigint>();

  for (const doc of docs) {
    for (const rec of recognizeCashBasisDocument(doc)) {
      if (window && (rec.date < window.start || rec.date > window.end)) continue;
      byAccount.set(
        rec.accountId,
        (byAccount.get(rec.accountId) ?? 0n) + decimalToMinor(rec.amount, SCALE),
      );
    }
  }

  return Array.from(byAccount.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([accountId, minor]) => ({ accountId, amount: minorToDecimal(minor, SCALE) }));
}

/**
 * The A/R- and A/P-facing shape of ONE journal entry, in decimal strings.
 * Everything the cash/accrual split of that entry's P&L lines depends on.
 */
export interface CashBasisEntryShape {
  /** Sum of every debit on the entry — equal to the sum of every credit. */
  total: string;
  /** Debits to accounts_receivable: a receivable CREATED (an invoice). */
  arDebit: string;
  /** Credits to accounts_receivable: a receivable SETTLED (a receipt). */
  arCredit: string;
  /** Debits to accounts_payable: a payable SETTLED (a vendor payment). */
  apDebit: string;
  /** Credits to accounts_payable: a payable CREATED (a bill). */
  apCredit: string;
  /** Does the entry move money through a bank or credit-card account? */
  movesCash: boolean;
}

/**
 * How much of ONE P&L line on ONE entry cash basis may recognise.
 *
 * A journal entry is balanced, so every line is funded pro rata by the opposite
 * side. A P&L line is recognisable to the extent the opposite side is CASH
 * rather than an A/R/A/P accrual, which turns on direction, not on the mere
 * presence of an A/R or A/P line:
 *
 *   • A/R debit / A/P credit — a receivable or payable was CREATED. Nothing was
 *     collected or paid, so the P&L it funds is accrual. Not recognisable.
 *   • A/R credit / A/P debit — a receivable or payable was SETTLED. When the
 *     entry also moves cash, that settlement IS the money changing hands, so
 *     the P&L it funds was genuinely received or paid. Recognisable.
 *   • A settlement on an entry that moves NO cash is a write-off, an offset or
 *     the reversing entry a void writes. Nothing was collected or paid, so it
 *     is not recognisable — this is what keeps a bad-debt write-off out of a
 *     cash-basis deduction and stops a void from recognising negative revenue.
 *   • Everything else (bank, credit card, other balance-sheet accounts) is
 *     treated as cash-side, which is what makes an entry with no A/R or A/P
 *     line at all recognise in full — identical to accrual, as it must be.
 *
 * Worked from the block comment's two examples: a receipt banked net of a fee
 * (DR bank 970 / DR merchant fees 30 / CR A/R 1,000) has no A/R debit, so the
 * fee's opposite side is all cash and all 30.00 is deductible; an invoice
 * (DR A/R 1,000 / CR revenue 1,000) has an A/R debit for the whole entry, so
 * none of the revenue is recognised here — it is recognised later, on the
 * payment date, through payment_applications.
 *
 * `amount` is the gross debit or credit posted by the line, and may be signed;
 * the result carries the same sign and never exceeds it in magnitude. All
 * arithmetic is BigInt at the ledger's NUMERIC(19,4) scale.
 */
export function cashBasisEntryRecognisableAmount(
  shape: CashBasisEntryShape,
  side: 'debit' | 'credit',
  amount: string,
): string {
  const SCALE = 10000n;
  const total = decimalToMinor(shape.total, SCALE);
  const value = decimalToMinor(amount, SCALE);
  if (value === 0n) return minorToDecimal(0n, SCALE);
  // A zero-total entry cannot post a non-zero line; treat it as nothing to
  // prorate rather than dividing by zero.
  if (total <= 0n) return minorToDecimal(0n, SCALE);

  const arDebit = decimalToMinor(shape.arDebit, SCALE);
  const arCredit = decimalToMinor(shape.arCredit, SCALE);
  const apDebit = decimalToMinor(shape.apDebit, SCALE);
  const apCredit = decimalToMinor(shape.apCredit, SCALE);

  // The non-cash pool on the side that funds this line. A settlement counts as
  // cash only when the entry actually moved some.
  const accrualPool =
    side === 'debit'
      ? apCredit + (shape.movesCash ? 0n : arCredit)
      : arDebit + (shape.movesCash ? 0n : apDebit);

  let cashPool = total - accrualPool;
  if (cashPool <= 0n) return minorToDecimal(0n, SCALE);
  if (cashPool > total) cashPool = total;

  const sign = value < 0n ? -1n : 1n;
  const abs = value < 0n ? -value : value;
  return minorToDecimal(sign * ((abs * cashPool) / total), SCALE);
}

/**
 * Round a ten-thousandth-scale minor amount to whole cents, half away from
 * zero, and give it back at the same scale. Used once per reported figure so
 * the P&L's line items foot to its own totals.
 */
function roundMinorToCents(minor: bigint): bigint {
  const step = 100n;
  const sign = minor < 0n ? -1n : 1n;
  const abs = minor < 0n ? -minor : minor;
  return sign * (((abs + step / 2n) / step) * step);
}

async function cashBasisProfitAndLoss(
  db: Database,
  start: string,
  end: string,
): Promise<ProfitAndLoss> {
  const SCALE = 10000n;

  // 1. Row skeleton — the same accounts, in the same order, as accrual.
  const accountRows = await db.execute(sql`
    SELECT
      a.id   AS account_id,
      a.code AS code,
      a.name AS name,
      a.type AS type
    FROM accounts a
    WHERE a.type IN ('revenue', 'expense')
      AND a.is_active = true
    ORDER BY a.code
  `);

  // 2. Bucket 1: P&L activity on entries that touch neither A/R nor A/P. The
  //    entry date IS the cash date, so this aggregates straight to the account
  //    exactly as the accrual query does.
  const directRows = await db.execute(sql`
    WITH ar_ap_entries AS (
      SELECT DISTINCT jl.entry_id AS entry_id
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE a.subtype IN ('accounts_receivable', 'accounts_payable')
        AND je.entry_date BETWEEN ${start}::date AND ${end}::date
    )
    SELECT
      jl.account_id AS account_id,
      COALESCE(SUM(jl.credit - jl.debit), 0) AS credit_minus_debit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.type IN ('revenue', 'expense')
      AND a.is_active = true
      AND je.entry_date BETWEEN ${start}::date AND ${end}::date
      AND jl.entry_id NOT IN (SELECT entry_id FROM ar_ap_entries)
    GROUP BY jl.account_id
  `);

  // 2b. Every P&L line on an entry that DOES touch A/R or A/P, one row per
  //     (entry, account), carrying that entry's A/R/A/P shape. Each row is then
  //     split into its cash half (recognised here, on the entry date, because
  //     the money moved here) and its accrual half, by
  //     cashBasisEntryRecognisableAmount.
  //
  //     `has_document` governs the DISCLOSURE only. When an invoices/bills row
  //     resolves from the entry's source, the accrual half is recognised on its
  //     payment dates through payment_applications instead — disclosing it as
  //     left out would contradict the figures above and invite a preparer to
  //     add income back that is already in them. Only an entry with no document
  //     behind it (IIF-imported GL, a hand-keyed A/R journal) has a gap no
  //     payment will ever close, and only that gap is disclosed.
  const mixedRows = await db.execute(sql`
    WITH windowed AS (
      SELECT je.id AS entry_id, je.source_type AS source_type, je.source_id AS source_id
      FROM journal_entries je
      WHERE je.entry_date BETWEEN ${start}::date AND ${end}::date
    ),
    shape AS (
      SELECT
        jl.entry_id AS entry_id,
        COALESCE(SUM(jl.debit), 0) AS total,
        COALESCE(SUM(CASE WHEN a.subtype = 'accounts_receivable' THEN jl.debit  ELSE 0 END), 0) AS ar_debit,
        COALESCE(SUM(CASE WHEN a.subtype = 'accounts_receivable' THEN jl.credit ELSE 0 END), 0) AS ar_credit,
        COALESCE(SUM(CASE WHEN a.subtype = 'accounts_payable'    THEN jl.debit  ELSE 0 END), 0) AS ap_debit,
        COALESCE(SUM(CASE WHEN a.subtype = 'accounts_payable'    THEN jl.credit ELSE 0 END), 0) AS ap_credit,
        BOOL_OR(a.subtype IN ('bank', 'credit_card')) AS moves_cash
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id IN (SELECT entry_id FROM windowed)
      GROUP BY jl.entry_id
      HAVING BOOL_OR(a.subtype IN ('accounts_receivable', 'accounts_payable'))
    ),
    sourced AS (
      -- Only for the entries the shape CTE kept. A reversal (what a void
      -- writes) carries the ORIGINAL entry's id as its source_id, so resolve
      -- one hop before looking for the document.
      SELECT
        w.entry_id AS entry_id,
        CASE COALESCE(orig.source_type, w.source_type)
          WHEN 'invoice' THEN EXISTS (
            SELECT 1 FROM invoices i WHERE i.id = COALESCE(orig.source_id, w.source_id)
          )
          WHEN 'bill' THEN EXISTS (
            SELECT 1 FROM bills b WHERE b.id = COALESCE(orig.source_id, w.source_id)
          )
          WHEN 'payment' THEN EXISTS (
            SELECT 1 FROM payments p WHERE p.id = COALESCE(orig.source_id, w.source_id)
          )
          ELSE false
        END AS has_document
      FROM windowed w
      LEFT JOIN journal_entries orig
        ON w.source_type = 'reversal' AND orig.id = w.source_id
      WHERE w.entry_id IN (SELECT entry_id FROM shape)
    )
    SELECT
      s.entry_id        AS entry_id,
      jl.account_id     AS account_id,
      a.type            AS type,
      s.total           AS total,
      s.ar_debit        AS ar_debit,
      s.ar_credit       AS ar_credit,
      s.ap_debit        AS ap_debit,
      s.ap_credit       AS ap_credit,
      s.moves_cash      AS moves_cash,
      src.has_document  AS has_document,
      COALESCE(SUM(jl.debit), 0)  AS debit,
      COALESCE(SUM(jl.credit), 0) AS credit
    FROM journal_lines jl
    JOIN shape s ON s.entry_id = jl.entry_id
    JOIN sourced src ON src.entry_id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.type IN ('revenue', 'expense')
      AND a.is_active = true
    GROUP BY s.entry_id, jl.account_id, a.type, s.total, s.ar_debit, s.ar_credit,
             s.ap_debit, s.ap_credit, s.moves_cash, src.has_document
  `);

  // 3. Every non-void application against a non-void document that took at
  //    least one non-void payment inside the window. Applications from OUTSIDE
  //    the window come along too: recognition is cumulative across a document's
  //    payments (see recognizeCashBasisDocument), so an instalment can only be
  //    split correctly against everything already paid before it. The window is
  //    applied afterwards, to the recognition dates, in
  //    recognizeCashBasisTotals. payment_date is rendered with to_char so the
  //    recognition date is a plain YYYY-MM-DD string whatever the driver does
  //    with DATE columns — the pure recogniser compares those as strings.
  const applicationRows = await db.execute(sql`
    WITH paid AS (
      SELECT DISTINCT pa.invoice_id AS invoice_id, pa.bill_id AS bill_id
      FROM payment_applications pa
      JOIN payments p ON p.id = pa.payment_id
      WHERE p.status <> 'void'
        AND p.payment_date BETWEEN ${start}::date AND ${end}::date
    )
    SELECT
      CASE WHEN pa.invoice_id IS NOT NULL THEN 'invoice' ELSE 'bill' END AS doc_kind,
      COALESCE(pa.invoice_id, pa.bill_id)   AS doc_id,
      COALESCE(i.total, b.total)            AS doc_total,
      p.id                                  AS payment_id,
      to_char(p.payment_date, 'YYYY-MM-DD') AS payment_date,
      pa.amount                             AS applied_amount
    FROM payment_applications pa
    JOIN payments p ON p.id = pa.payment_id
    LEFT JOIN invoices i ON i.id = pa.invoice_id
    LEFT JOIN bills    b ON b.id = pa.bill_id
    WHERE p.status <> 'void'
      AND (i.id IS NULL OR i.status <> 'void')
      AND (b.id IS NULL OR b.status <> 'void')
      AND (
        pa.invoice_id IN (SELECT invoice_id FROM paid WHERE invoice_id IS NOT NULL)
        OR pa.bill_id IN (SELECT bill_id FROM paid WHERE bill_id IS NOT NULL)
      )
    ORDER BY 1, 2, 5, 4
  `);

  // 4. The lines of exactly those documents, in line_number order (the
  //    remainder-on-the-largest-line tiebreak depends on that order).
  const lineRows = await db.execute(sql`
    WITH paid AS (
      SELECT DISTINCT pa.invoice_id AS invoice_id, pa.bill_id AS bill_id
      FROM payment_applications pa
      JOIN payments p ON p.id = pa.payment_id
      WHERE p.status <> 'void'
        AND p.payment_date BETWEEN ${start}::date AND ${end}::date
    )
    SELECT
      'invoice'      AS doc_kind,
      il.invoice_id  AS doc_id,
      il.line_number AS line_number,
      il.account_id  AS account_id,
      il.amount      AS amount
    FROM invoice_lines il
    WHERE il.invoice_id IN (SELECT invoice_id FROM paid WHERE invoice_id IS NOT NULL)
    UNION ALL
    SELECT
      'bill',
      bl.bill_id,
      bl.line_number,
      bl.account_id,
      bl.amount
    FROM bill_lines bl
    WHERE bl.bill_id IN (SELECT bill_id FROM paid WHERE bill_id IS NOT NULL)
    ORDER BY 1, 2, 3
  `);

  // Assemble one CashBasisDocument per paid document, then hand the whole set
  // to the pure recogniser. The SQL applied the void filters; the date window
  // is applied by the recogniser, because the payments feeding a cumulative
  // allocation deliberately reach outside it.
  const docs = new Map<
    string,
    Omit<CashBasisDocument, 'lines' | 'payments'> & {
      lines: CashBasisLine[];
      payments: CashBasisPayment[];
    }
  >();

  for (const r of applicationRows as unknown as Array<Record<string, unknown>>) {
    const key = `${String(r.doc_kind)}:${String(r.doc_id)}`;
    let doc = docs.get(key);
    if (!doc) {
      doc = {
        documentId: String(r.doc_id),
        side: r.doc_kind === 'invoice' ? 'credit' : 'debit',
        total: String(r.doc_total ?? '0'),
        lines: [],
        payments: [],
      };
      docs.set(key, doc);
    }
    doc.payments.push({
      paymentId: String(r.payment_id),
      date: String(r.payment_date),
      amount: String(r.applied_amount),
    });
  }

  for (const r of lineRows as unknown as Array<Record<string, unknown>>) {
    const doc = docs.get(`${String(r.doc_kind)}:${String(r.doc_id)}`);
    if (!doc) continue;
    doc.lines.push({ accountId: String(r.account_id), amount: String(r.amount) });
  }

  const byAccount = new Map<string, bigint>();
  for (const rec of recognizeCashBasisTotals(Array.from(docs.values()), { start, end })) {
    byAccount.set(rec.accountId, decimalToMinor(rec.amount, SCALE));
  }

  for (const r of directRows as unknown as Array<Record<string, unknown>>) {
    const accountId = String(r.account_id);
    const creditMinusDebit = decimalToMinor(String(r.credit_minus_debit ?? '0'), SCALE);
    byAccount.set(accountId, (byAccount.get(accountId) ?? 0n) + creditMinusDebit);
  }

  let unlinkedRev = 0n;
  let unlinkedExp = 0n;
  for (const r of mixedRows as unknown as Array<Record<string, unknown>>) {
    const shape: CashBasisEntryShape = {
      total: String(r.total ?? '0'),
      arDebit: String(r.ar_debit ?? '0'),
      arCredit: String(r.ar_credit ?? '0'),
      apDebit: String(r.ap_debit ?? '0'),
      apCredit: String(r.ap_credit ?? '0'),
      movesCash: r.moves_cash === true,
    };
    const debit = String(r.debit ?? '0');
    const credit = String(r.credit ?? '0');
    const postedMinor = decimalToMinor(credit, SCALE) - decimalToMinor(debit, SCALE);
    const recognisedMinor =
      decimalToMinor(cashBasisEntryRecognisableAmount(shape, 'credit', credit), SCALE) -
      decimalToMinor(cashBasisEntryRecognisableAmount(shape, 'debit', debit), SCALE);

    const accountId = String(r.account_id);
    byAccount.set(accountId, (byAccount.get(accountId) ?? 0n) + recognisedMinor);

    // The accrual half. Disclose it only when nothing can ever recover it —
    // with a document behind the entry it comes back through the payments.
    if (r.has_document === true) continue;
    const excluded = postedMinor - recognisedMinor;
    if (r.type === 'revenue') unlinkedRev += excluded;
    else unlinkedExp -= excluded;
  }

  const revenue: ProfitAndLossSection[] = [];
  const expenses: ProfitAndLossSection[] = [];
  let totalRev = 0n;
  let totalExp = 0n;

  for (const r of accountRows as unknown as Array<Record<string, unknown>>) {
    const accountId = String(r.account_id);
    // Stored credit-positive; flip for expenses so both read natural-sign,
    // exactly like the accrual query's CASE. Rounded to cents HERE, once, and
    // the totals below accumulate the rounded figures — so the column the
    // report prints adds up to the total the report prints.
    const creditMinusDebit = byAccount.get(accountId) ?? 0n;
    const minor = roundMinorToCents(r.type === 'revenue' ? creditMinusDebit : -creditMinusDebit);
    const section: ProfitAndLossSection = {
      accountId,
      code: String(r.code),
      name: String(r.name),
      amount: minorToDecimal(minor, SCALE),
    };
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
    basis: 'cash',
    revenue,
    expenses,
    totalRevenue: minorToDecimal(totalRev, SCALE),
    totalExpenses: minorToDecimal(totalExp, SCALE),
    netIncome: minorToDecimal(totalRev - totalExp, SCALE),
    unlinkedAccrualActivity: {
      revenue: minorToDecimal(roundMinorToCents(unlinkedRev), SCALE),
      expenses: minorToDecimal(roundMinorToCents(unlinkedExp), SCALE),
    },
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
          THEN COALESCE(SUM(CASE WHEN je.entry_date <= ${asOf}::date THEN jl.debit  ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN je.entry_date <= ${asOf}::date THEN jl.credit ELSE 0 END), 0)
        WHEN a.type IN ('liability', 'equity')
          THEN COALESCE(SUM(CASE WHEN je.entry_date <= ${asOf}::date THEN jl.credit ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN je.entry_date <= ${asOf}::date THEN jl.debit  ELSE 0 END), 0)
      END AS amount
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.entry_id
    -- Date predicate inside the aggregates, not on the LEFT JOIN — see trialBalance.
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

  // Roll cumulative net income (revenue/expense activity through asOf) into
  // equity as a virtual line, the way QuickBooks shows "Net Income" on the
  // balance sheet. Without it the equation can never balance, since KPBooks
  // has no year-end closing entries. Over revenue+expense lines,
  // SUM(credit - debit) IS net income (revenue normal-credit, expense
  // normal-debit). `imbalance` then only flags genuine inconsistencies.
  const niRows = await db.execute(sql`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS net_income
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.type IN ('revenue', 'expense')
      AND je.entry_date <= ${asOf}::date
  `);
  const netIncomeStr = String(
    (niRows as unknown as Array<Record<string, unknown>>)[0]?.net_income ?? '0',
  );
  const netIncomeMinor = decimalToMinor(netIncomeStr, SCALE);
  if (netIncomeMinor !== 0n) {
    equity.push({
      accountId: 'virtual-net-income',
      code: '',
      name: 'Net Income',
      amount: netIncomeStr,
    });
    totalEq += netIncomeMinor;
  }

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

/** Where a contractor year-total came from. See nineteenNinetyNineSummary. */
export type NinetyNineSource = 'account' | 'payments';

export interface NinetyNineRow {
  vendorId: string;
  displayName: string;
  taxId: string | null;
  mailingAddress: Record<string, unknown> | null;
  /** Amount to report for the calendar year. */
  total: string;
  /**
   * 'account' when the figure came from an expense account named after this
   * contractor; 'payments' when it came from posted vendor payments.
   */
  source: NinetyNineSource;
  /** The expense account the total was read from, when source is account. */
  sourceAccountName: string | null;
  /**
   * True when more than one expense account matches this contractor name, so
   * the total is a sum across them and worth eyeballing before filing.
   */
  ambiguousAccount: boolean;
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
  // Two charting styles have to work here.
  //
  // This practice gives every 1099 contractor their own expense sub-account
  // ("Subcontractors:Carlos Arana") and posts journal entries straight to it;
  // there are no vendor bills or payments to total. Other books pay vendors
  // through the payments table in the usual way.
  //
  // Summing BOTH would double-count any book that does both -- entering a
  // bill debits the expense account, and paying it writes a payments row for
  // the same money. So each contractor resolves to exactly one source: the
  // expense account when a matching one exists, otherwise their payments.
  //
  // Matching is on the LEAF of the account path, because the account is named
  // for the contractor but nested under a parent like "Subcontractors".
  const rows = await db.execute(sql`
    WITH account_totals AS (
      SELECT
        lower(btrim(regexp_replace(a.name, '^.*:', ''))) AS leaf,
        SUM(COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0)) AS total,
        COUNT(DISTINCT a.id)                               AS account_count,
        MIN(a.name)                                        AS account_name
      FROM accounts a
      JOIN journal_lines jl   ON jl.account_id = a.id
      JOIN journal_entries je ON je.id = jl.entry_id
                             AND je.entry_date BETWEEN ${start}::date AND ${end}::date
      WHERE a.type = 'expense'
      GROUP BY 1
    ),
    payment_totals AS (
      SELECT p.vendor_id, SUM(p.amount) AS total
      FROM payments p
      WHERE p.payment_type = 'vendor_sent'
        AND p.status = 'posted'
        AND p.payment_date BETWEEN ${start}::date AND ${end}::date
      GROUP BY p.vendor_id
    )
    SELECT
      v.id              AS vendor_id,
      v.display_name    AS display_name,
      v.tax_id          AS tax_id,
      v.mailing_address AS mailing_address,
      at.total          AS account_total,
      at.account_name   AS account_name,
      at.account_count  AS account_count,
      COALESCE(pt.total, 0) AS payment_total
    FROM vendors v
    LEFT JOIN account_totals at ON at.leaf = lower(btrim(v.display_name))
    LEFT JOIN payment_totals pt ON pt.vendor_id = v.id
    WHERE v.is_1099_vendor = true
    ORDER BY COALESCE(at.total, pt.total, 0) DESC, v.display_name
  `);

  const SCALE = 10000n;
  let grandTotal = 0n;
  let aboveThreshold = 0;
  let missingAbove = 0;
  const SIX_HUNDRED = 6000000n; // $600.0000 in 4dp micros

  const out: NinetyNineRow[] = (rows as unknown as Array<Record<string, unknown>>).map((r) => {
    // A matching expense account wins even when it nets to zero: that is a
    // real answer about how this contractor is charted, and falling through
    // to payments would mix the two bases for one contractor.
    const hasAccount = r.account_total !== null && r.account_total !== undefined;
    const source: NinetyNineSource = hasAccount ? 'account' : 'payments';
    const total = String((hasAccount ? r.account_total : r.payment_total) ?? '0');
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
      source,
      sourceAccountName: hasAccount && r.account_name ? String(r.account_name) : null,
      ambiguousAccount: hasAccount && Number(r.account_count ?? 1) > 1,
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

// ─── General ledger + account detail (drill-down) ─────────────────────────

/**
 * Which side an account's balance grows on. Asset and expense accounts are
 * debit-positive; liability, equity and revenue accounts are credit-positive.
 * Both detail reports run their opening and running balances through this, so
 * a revenue account reads +1,000.00 after a 1,000.00 credit rather than
 * -1,000.00, which is what an accountant expects to see on a ledger page.
 */
export type NormalBalance = 'debit' | 'credit';

export function normalBalanceOf(type: TrialBalanceRow['type']): NormalBalance {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/** The source document behind a ledger row, named the way a preparer names it. */
export type LedgerDocumentType =
  | 'invoice'
  | 'bill'
  | 'payment'
  | 'journal'
  | 'bank_transaction'
  | 'reconciliation'
  | 'payroll'
  | 'import';

const SOURCE_TYPE_TO_DOCUMENT_TYPE: Record<string, LedgerDocumentType> = {
  invoice: 'invoice',
  bill: 'bill',
  payment: 'payment',
  bank_transaction: 'bank_transaction',
  reconciliation: 'reconciliation',
  payroll: 'payroll',
  import: 'import',
  // A hand-keyed entry reads as "journal", and so does a reversal whose
  // original entry had no subledger document behind it. When the original DOES
  // have one — the ordinary void of an invoice, bill or payment — the query
  // resolves through to that document, so the row reads as an invoice/bill/
  // payment with `isReversal` set rather than as an anonymous journal.
  manual: 'journal',
  reversal: 'journal',
};

export function ledgerDocumentTypeOf(sourceType: string): LedgerDocumentType {
  return SOURCE_TYPE_TO_DOCUMENT_TYPE[sourceType] ?? 'journal';
}

export interface LedgerDetailRow {
  /** journal_lines.id — stable row key for the UI. */
  lineId: string;
  entryId: string;
  entryDate: string;
  documentType: LedgerDocumentType;
  /**
   * Invoice number, bill number, payment reference, or failing all of those
   * the entry's own reference (an IIF-imported check number lands here).
   * Null when the entry carries no identifier at all.
   */
  documentNumber: string | null;
  /**
   * True when this line is the mirror written by a void/reversal. The row keeps
   * the voided document's type and number, so a voided invoice still reads as
   * INV-1041 — this flag is what marks it as the reversing side.
   */
  isReversal: boolean;
  /** Line memo, falling back to the entry memo. */
  memo: string | null;
  /** Customer or vendor behind the document; IIF payee name as a fallback. */
  counterpartyName: string | null;
  debit: string;
  credit: string;
  /** Opening balance plus every row through this one, normal-balance signed. */
  runningBalance: string;
}

export interface LedgerAccountGroup {
  accountId: string;
  code: string;
  name: string;
  type: TrialBalanceRow['type'];
  subtype: string;
  /**
   * Inactive accounts with history ARE included — unlike the trial balance and
   * the P&L, a drill-down report that silently hides posted transactions is
   * worse than one that shows a deactivated account. The flag lets the UI
   * badge it.
   */
  isActive: boolean;
  normalBalance: NormalBalance;
  /** Every posting strictly before `start`, normal-balance signed. */
  openingBalance: string;
  /** Period totals over EVERY row in range — never affected by the row cap. */
  totalDebit: string;
  totalCredit: string;
  /** openingBalance ± period net. Always the true closing balance. */
  closingBalance: string;
  /** Rows in range for this account, before any cap. */
  rowCount: number;
  rows: LedgerDetailRow[];
  /** True when `rows.length < rowCount` — the cap cut this account short. */
  truncated: boolean;
}

export interface GeneralLedgerReport {
  start: string;
  end: string;
  /** Echoes the accountId filter, or null for the whole chart. */
  accountId: string | null;
  accounts: LedgerAccountGroup[];
  /** Row cap applied across ALL accounts combined. */
  rowCap: number;
  /** Rows in range across every account, before the cap. */
  totalRowCount: number;
  /** Rows actually returned. */
  returnedRows: number;
  /** True when the cap bit. Per-account summaries stay exact either way. */
  truncated: boolean;
  totals: { totalDebit: string; totalCredit: string; accountCount: number };
}

export interface AccountDetailReport {
  start: string;
  end: string;
  account: {
    accountId: string;
    code: string;
    name: string;
    type: TrialBalanceRow['type'];
    subtype: string;
    isActive: boolean;
    normalBalance: NormalBalance;
  };
  /** Every posting strictly before `start`, normal-balance signed. */
  openingBalance: string;
  /** Balance carried into the first returned row: opening + everything `offset` skipped. */
  pageOpeningBalance: string;
  rows: LedgerDetailRow[];
  /** Period totals over EVERY row in range, not just this page. */
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
  /** Rows in range across all pages. */
  rowCount: number;
  limit: number;
  offset: number;
  returnedRows: number;
  /** True when this page does not contain every row in range. */
  truncated: boolean;
  /** True when rows remain after this page — refetch with offset += limit. */
  hasMore: boolean;
}

/**
 * Default and hard caps.
 *
 * generalLedger returns at most `rowCap` detail rows ACROSS ALL ACCOUNTS
 * (default 5,000, hard maximum 20,000). Nothing is ever silently dropped: the
 * per-account opening balance, period debit/credit totals, closing balance and
 * rowCount come from a separate aggregate query that the cap does not touch, so
 * a truncated group still reports correct money — only its `rows` array is
 * short, and `truncated` says so on both the group and the report. To read
 * every row of a busy account, drill into accountDetail, which paginates.
 */
export const GENERAL_LEDGER_ROW_CAP = 5000;
export const GENERAL_LEDGER_MAX_ROW_CAP = 20000;
export const ACCOUNT_DETAIL_PAGE_SIZE = 500;
export const ACCOUNT_DETAIL_MAX_PAGE_SIZE = 5000;

/**
 * Roll a running balance down a set of rows, honouring the account's normal
 * balance. Pure — the SQL supplies the opening carry and the raw debits and
 * credits, this decides what the accountant sees. BigInt minor units at the
 * ledger's NUMERIC(19,4) scale, so no float ever touches a balance.
 */
export function ledgerRunningBalances(
  normalBalance: NormalBalance,
  openingBalance: string,
  rows: readonly { debit: string; credit: string }[],
): string[] {
  const SCALE = 10000n;
  let running = decimalToMinor(openingBalance, SCALE);
  return rows.map((r) => {
    const debit = decimalToMinor(r.debit, SCALE);
    const credit = decimalToMinor(r.credit, SCALE);
    running += normalBalance === 'debit' ? debit - credit : credit - debit;
    return minorToDecimal(running, SCALE);
  });
}

/**
 * The detail-row projection shared by both reports.
 *
 * Provenance resolution: journal_entries.source_id points at the invoice, bill
 * or payment that produced the entry. A void writes a reversal whose source_id
 * is the ORIGINAL ENTRY, so we hop through `oe` first and resolve the document
 * behind that — otherwise every void row would read as an anonymous journal.
 * IIF-imported entries stamp a content-hash source_id that matches no
 * subledger row; those joins simply miss and the row falls back to the entry's
 * own reference plus the payee name the importer parked in dimension_json.
 *
 * entry_date goes through to_char: the driver parses DATE columns into JS Date
 * objects, and these reports move dates as plain YYYY-MM-DD strings.
 */
const LEDGER_DETAIL_PROJECTION = sql`
      jl.id                                    AS line_id,
      jl.account_id                            AS account_id,
      je.id                                    AS entry_id,
      to_char(je.entry_date, 'YYYY-MM-DD')     AS entry_date,
      COALESCE(oe.source_type, je.source_type) AS document_source_type,
      (je.source_type = 'reversal')            AS is_reversal,
      COALESCE(jl.memo, je.memo)               AS memo,
      jl.debit                                 AS debit,
      jl.credit                                AS credit,
      COALESCE(i.invoice_number, b.bill_number, p.reference, je.reference) AS document_number,
      COALESCE(cu.display_name, vn.display_name, jl.dimension_json->>'name') AS counterparty_name`;

const LEDGER_DETAIL_JOINS = sql`
    JOIN journal_entries je ON je.id = jl.entry_id
    LEFT JOIN journal_entries oe
           ON je.source_type = 'reversal'
          AND oe.id = je.source_id
    LEFT JOIN invoices i
           ON COALESCE(oe.source_type, je.source_type) = 'invoice'
          AND i.id = COALESCE(oe.source_id, je.source_id)
    LEFT JOIN bills b
           ON COALESCE(oe.source_type, je.source_type) = 'bill'
          AND b.id = COALESCE(oe.source_id, je.source_id)
    LEFT JOIN payments p
           ON COALESCE(oe.source_type, je.source_type) = 'payment'
          AND p.id = COALESCE(oe.source_id, je.source_id)
    LEFT JOIN customers cu ON cu.id = COALESCE(i.customer_id, p.customer_id)
    LEFT JOIN vendors   vn ON vn.id = COALESCE(b.vendor_id,   p.vendor_id)`;

/** Shape one raw projection row; runningBalance is filled in by the caller. */
function toLedgerDetailRow(r: Record<string, unknown>): LedgerDetailRow {
  return {
    lineId: String(r.line_id),
    entryId: String(r.entry_id),
    entryDate: String(r.entry_date),
    documentType: ledgerDocumentTypeOf(String(r.document_source_type)),
    documentNumber: r.document_number === null || r.document_number === undefined
      ? null
      : String(r.document_number),
    isReversal: r.is_reversal === true,
    memo: r.memo === null || r.memo === undefined ? null : String(r.memo),
    counterpartyName: r.counterparty_name === null || r.counterparty_name === undefined
      ? null
      : String(r.counterparty_name),
    debit: String(r.debit ?? '0'),
    credit: String(r.credit ?? '0'),
    runningBalance: '0.0000',
  };
}

/**
 * General ledger for [start, end] — every posted line grouped by account, in
 * date order, with an opening balance per account (all activity strictly
 * before `start`) and a running balance down the rows.
 *
 * Accounts appear when they have activity in the range OR a non-zero opening
 * balance, so a dormant account still shows what it is carrying. Inactive
 * accounts with history are included (see LedgerAccountGroup.isActive).
 *
 * Row cap: see GENERAL_LEDGER_ROW_CAP. The cap only shortens `rows`; every
 * money figure on the group is computed from the full range.
 */
export async function generalLedger(
  db: Database,
  start: string,
  end: string,
  opts: { accountId?: string | undefined; rowCap?: number } = {},
): Promise<GeneralLedgerReport> {
  const SCALE = 10000n;
  const accountId = opts.accountId;
  const rowCap = Math.max(
    1,
    Math.min(opts.rowCap ?? GENERAL_LEDGER_ROW_CAP, GENERAL_LEDGER_MAX_ROW_CAP),
  );

  // Summary pass — exact for the whole range, never touched by the row cap.
  // The date predicate lives inside the aggregates, not on the LEFT JOIN; see
  // the note in trialBalance for why that matters.
  const summaryRows = await db.execute(sql`
    SELECT
      a.id        AS account_id,
      a.code      AS code,
      a.name      AS name,
      a.type      AS type,
      a.subtype   AS subtype,
      a.is_active AS is_active,
      COALESCE(SUM(CASE WHEN je.entry_date < ${start}::date THEN jl.debit  ELSE 0 END), 0) AS opening_debit,
      COALESCE(SUM(CASE WHEN je.entry_date < ${start}::date THEN jl.credit ELSE 0 END), 0) AS opening_credit,
      COALESCE(SUM(CASE WHEN je.entry_date BETWEEN ${start}::date AND ${end}::date THEN jl.debit  ELSE 0 END), 0) AS period_debit,
      COALESCE(SUM(CASE WHEN je.entry_date BETWEEN ${start}::date AND ${end}::date THEN jl.credit ELSE 0 END), 0) AS period_credit,
      COUNT(jl.id) FILTER (WHERE je.entry_date BETWEEN ${start}::date AND ${end}::date) AS row_count
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.entry_id
    ${accountId ? sql`WHERE a.id = ${accountId}::uuid` : sql``}
    GROUP BY a.id, a.code, a.name, a.type, a.subtype, a.is_active
    HAVING COUNT(jl.id) FILTER (WHERE je.entry_date BETWEEN ${start}::date AND ${end}::date) > 0
        OR COALESCE(SUM(CASE WHEN je.entry_date < ${start}::date THEN jl.debit  ELSE 0 END), 0)
        <> COALESCE(SUM(CASE WHEN je.entry_date < ${start}::date THEN jl.credit ELSE 0 END), 0)
    ORDER BY a.code, a.id
  `);

  const groups = new Map<string, LedgerAccountGroup>();
  const order: string[] = [];
  let totalRowCount = 0;
  let grandDebit = 0n;
  let grandCredit = 0n;

  for (const r of summaryRows as unknown as Array<Record<string, unknown>>) {
    const id = String(r.account_id);
    const type = r.type as TrialBalanceRow['type'];
    const normalBalance = normalBalanceOf(type);
    const openingDebit = decimalToMinor(String(r.opening_debit ?? '0'), SCALE);
    const openingCredit = decimalToMinor(String(r.opening_credit ?? '0'), SCALE);
    const opening =
      normalBalance === 'debit' ? openingDebit - openingCredit : openingCredit - openingDebit;
    const periodDebit = decimalToMinor(String(r.period_debit ?? '0'), SCALE);
    const periodCredit = decimalToMinor(String(r.period_credit ?? '0'), SCALE);
    const periodNet =
      normalBalance === 'debit' ? periodDebit - periodCredit : periodCredit - periodDebit;
    const rowCount = Number(r.row_count ?? 0);

    totalRowCount += rowCount;
    grandDebit += periodDebit;
    grandCredit += periodCredit;

    groups.set(id, {
      accountId: id,
      code: String(r.code),
      name: String(r.name),
      type,
      subtype: String(r.subtype),
      isActive: r.is_active === true,
      normalBalance,
      openingBalance: minorToDecimal(opening, SCALE),
      totalDebit: minorToDecimal(periodDebit, SCALE),
      totalCredit: minorToDecimal(periodCredit, SCALE),
      closingBalance: minorToDecimal(opening + periodNet, SCALE),
      rowCount,
      rows: [],
      truncated: false,
    });
    order.push(id);
  }

  // Detail pass. Ordered the same way the summary is grouped (code, then id to
  // break duplicate codes), so the cap always cuts a clean tail rather than
  // scattering holes through the report.
  const detailRows = await db.execute(sql`
    SELECT${LEDGER_DETAIL_PROJECTION},
      a.code AS account_code
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id${LEDGER_DETAIL_JOINS}
    WHERE je.entry_date BETWEEN ${start}::date AND ${end}::date
      ${accountId ? sql`AND jl.account_id = ${accountId}::uuid` : sql``}
    ORDER BY a.code, a.id, je.entry_date, je.id, jl.id
    LIMIT ${rowCap}::int
  `);

  let returnedRows = 0;
  for (const r of detailRows as unknown as Array<Record<string, unknown>>) {
    const group = groups.get(String(r.account_id));
    // Unreachable: the HAVING above keeps every account with a row in range.
    if (!group) continue;
    group.rows.push(toLedgerDetailRow(r));
    returnedRows += 1;
  }

  const accounts: LedgerAccountGroup[] = [];
  for (const id of order) {
    const group = groups.get(id)!;
    const balances = ledgerRunningBalances(
      group.normalBalance,
      group.openingBalance,
      group.rows,
    );
    for (let i = 0; i < group.rows.length; i += 1) {
      group.rows[i]!.runningBalance = balances[i]!;
    }
    group.truncated = group.rows.length < group.rowCount;
    accounts.push(group);
  }

  return {
    start,
    end,
    accountId: accountId ?? null,
    accounts,
    rowCap,
    totalRowCount,
    returnedRows,
    truncated: returnedRows < totalRowCount,
    totals: {
      totalDebit: minorToDecimal(grandDebit, SCALE),
      totalCredit: minorToDecimal(grandCredit, SCALE),
      accountCount: accounts.length,
    },
  };
}

/**
 * The same detail for ONE account, paginated — this is what powers "click a
 * P&L number and see what's in it".
 *
 * Pagination is offset-based and the running balance stays correct across
 * pages: the SQL carries a windowed sum of everything before the first
 * returned row, so page 3 opens where page 2 closed instead of restarting from
 * the account's opening balance. Page size defaults to
 * ACCOUNT_DETAIL_PAGE_SIZE and is hard-capped at ACCOUNT_DETAIL_MAX_PAGE_SIZE;
 * `rowCount`, `truncated` and `hasMore` tell the caller exactly what is missing.
 *
 * Returns null when the account does not exist for this tenant (RLS makes a
 * foreign company's account indistinguishable from a deleted one, which is the
 * intent).
 */
export async function accountDetail(
  db: Database,
  accountId: string,
  start: string,
  end: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<AccountDetailReport | null> {
  const SCALE = 10000n;
  const limit = Math.max(
    1,
    Math.min(opts.limit ?? ACCOUNT_DETAIL_PAGE_SIZE, ACCOUNT_DETAIL_MAX_PAGE_SIZE),
  );
  const offset = Math.max(0, opts.offset ?? 0);

  const accountRows = await db.execute(sql`
    SELECT a.id, a.code, a.name, a.type, a.subtype, a.is_active
    FROM accounts a
    WHERE a.id = ${accountId}::uuid
  `);
  const acct = (accountRows as unknown as Array<Record<string, unknown>>)[0];
  if (!acct) return null;

  const type = acct.type as TrialBalanceRow['type'];
  const normalBalance = normalBalanceOf(type);

  // Exact figures for the whole range, independent of the page.
  const summaryRows = await db.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN je.entry_date < ${start}::date THEN jl.debit  ELSE 0 END), 0) AS opening_debit,
      COALESCE(SUM(CASE WHEN je.entry_date < ${start}::date THEN jl.credit ELSE 0 END), 0) AS opening_credit,
      COALESCE(SUM(CASE WHEN je.entry_date BETWEEN ${start}::date AND ${end}::date THEN jl.debit  ELSE 0 END), 0) AS period_debit,
      COALESCE(SUM(CASE WHEN je.entry_date BETWEEN ${start}::date AND ${end}::date THEN jl.credit ELSE 0 END), 0) AS period_credit,
      COUNT(jl.id) FILTER (WHERE je.entry_date BETWEEN ${start}::date AND ${end}::date) AS row_count
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_id = ${accountId}::uuid
  `);
  const s = (summaryRows as unknown as Array<Record<string, unknown>>)[0];
  const openingDebit = decimalToMinor(String(s?.opening_debit ?? '0'), SCALE);
  const openingCredit = decimalToMinor(String(s?.opening_credit ?? '0'), SCALE);
  const opening =
    normalBalance === 'debit' ? openingDebit - openingCredit : openingCredit - openingDebit;
  const periodDebit = decimalToMinor(String(s?.period_debit ?? '0'), SCALE);
  const periodCredit = decimalToMinor(String(s?.period_credit ?? '0'), SCALE);
  const periodNet =
    normalBalance === 'debit' ? periodDebit - periodCredit : periodCredit - periodDebit;
  const rowCount = Number(s?.row_count ?? 0);
  const closing = opening + periodNet;

  // Page. prior_debit/prior_credit are the running sums of everything BEFORE
  // each row in the full ordering; only the first returned row's pair is read,
  // and it is what makes the running balance survive a non-zero offset.
  const pageRows = await db.execute(sql`
    WITH ordered AS (
      SELECT${LEDGER_DETAIL_PROJECTION},
        ROW_NUMBER() OVER (ORDER BY je.entry_date, je.id, jl.id) AS rn,
        COALESCE(SUM(jl.debit) OVER (
          ORDER BY je.entry_date, je.id, jl.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior_debit,
        COALESCE(SUM(jl.credit) OVER (
          ORDER BY je.entry_date, je.id, jl.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior_credit
      FROM journal_lines jl${LEDGER_DETAIL_JOINS}
      WHERE jl.account_id = ${accountId}::uuid
        AND je.entry_date BETWEEN ${start}::date AND ${end}::date
    )
    SELECT * FROM ordered
    WHERE rn > ${offset}::bigint
    ORDER BY rn
    LIMIT ${limit}::int
  `);

  const raw = pageRows as unknown as Array<Record<string, unknown>>;
  const rows = raw.map((r) => toLedgerDetailRow(r));

  let pageOpening: bigint;
  const first = raw[0];
  if (first) {
    const priorDebit = decimalToMinor(String(first.prior_debit ?? '0'), SCALE);
    const priorCredit = decimalToMinor(String(first.prior_credit ?? '0'), SCALE);
    pageOpening =
      opening +
      (normalBalance === 'debit' ? priorDebit - priorCredit : priorCredit - priorDebit);
  } else {
    // No rows on this page: either the range is empty, or the offset ran past
    // the end, in which case everything in range was skipped and the carry is
    // the closing balance.
    pageOpening = offset >= rowCount ? closing : opening;
  }

  const pageOpeningBalance = minorToDecimal(pageOpening, SCALE);
  const balances = ledgerRunningBalances(normalBalance, pageOpeningBalance, rows);
  for (let i = 0; i < rows.length; i += 1) {
    rows[i]!.runningBalance = balances[i]!;
  }

  return {
    start,
    end,
    account: {
      accountId: String(acct.id),
      code: String(acct.code),
      name: String(acct.name),
      type,
      subtype: String(acct.subtype),
      isActive: acct.is_active === true,
      normalBalance,
    },
    openingBalance: minorToDecimal(opening, SCALE),
    pageOpeningBalance,
    rows,
    totalDebit: minorToDecimal(periodDebit, SCALE),
    totalCredit: minorToDecimal(periodCredit, SCALE),
    closingBalance: minorToDecimal(closing, SCALE),
    rowCount,
    limit,
    offset,
    returnedRows: rows.length,
    truncated: rows.length < rowCount,
    hasMore: offset + rows.length < rowCount,
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
