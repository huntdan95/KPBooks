import {
  type Database,
  accounts as accountsTable,
  companies as companiesTable,
  customers as customersTable,
  journalEntries,
  journalLines,
  payments as paymentsTable,
  vendors as vendorsTable,
} from '@kpbooks/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PostingError, postEntry } from '../ledger/posting.service.js';

/**
 * iif.ts -- parser + committer for QuickBooks IIF (Intuit Interchange Format)
 * exports.
 *
 * IIF is tab-separated. Lines starting with `!` define column order for the
 * section that follows. Lines starting with the same section name (no `!`)
 * are data rows. Sections we care about for v1 lists import:
 *
 *   !ACCNT  ...columns...    -- chart of accounts
 *   !CUST   ...columns...    -- customers
 *   !VEND   ...columns...    -- vendors
 *
 * Transaction sections (!TRNS/!SPL/!ENDTRNS) are parsed into posting blocks
 * and committed as journal entries by commitIifTransactions; money-OUT blocks
 * that name a known vendor also land in the payments subledger so 1099
 * totals and payroll registers see imported history. The A/R side gets no
 * subledger rows at all (no invoices, and therefore no customer payments
 * either -- see derivePaymentLink), and the commit result says so.
 *
 * Sub-account colon paths keep the full path as the account NAME
 * (transactions resolve by full path); commitIifImport additionally links
 * parent_id so report rollups survive the migration. Customer:job paths
 * still import flat -- the customers table has no hierarchy column yet; the
 * commit result warns when that happens. Other list sections (INVITEM, EMP,
 * CLASS, etc.) surface in unrecognizedSections so nothing drops silently.
 */

// ------------------------- Types --------------------------------------------

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type AccountSubtype =
  | 'bank'
  | 'accounts_receivable'
  | 'other_current_asset'
  | 'fixed_asset'
  | 'other_asset'
  | 'accounts_payable'
  | 'credit_card'
  | 'other_current_liability'
  | 'long_term_liability'
  | 'equity'
  | 'retained_earnings'
  | 'income'
  | 'other_income'
  | 'expense'
  | 'cost_of_goods_sold'
  | 'other_expense';

export interface ParsedAccount {
  name: string;
  qbType: string; // raw ACCNTTYPE value from the file (BANK, AR, INC, etc.)
  type: AccountType;
  subtype: AccountSubtype;
  description?: string | undefined;
  /** Auto-assigned suggestion: a 4-digit code derived from type ordering. */
  suggestedCode: string;
  /** False when the QBD row is marked HIDDEN=Y (made inactive in QBD). */
  isActive: boolean;
}

/** Best-effort structured address parsed from QBD's BADDR1-5/SADDR1-5 lines.
 * Same jsonb shape the CRUD routes use ({ street1, street2, city, state,
 * postalCode, country }). */
export type ParsedAddress = Record<string, string>;

export interface ParsedCustomer {
  displayName: string;
  companyName?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  notes?: string | undefined;
  defaultTermsDays?: number | undefined;
  billingAddress?: ParsedAddress | undefined;
  shippingAddress?: ParsedAddress | undefined;
  /** False when the QBD row is marked HIDDEN=Y (made inactive in QBD). */
  isActive: boolean;
}

export interface ParsedVendor {
  displayName: string;
  companyName?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  notes?: string | undefined;
  defaultTermsDays?: number | undefined;
  is1099Vendor: boolean;
  taxId?: string | undefined;
  mailingAddress?: ParsedAddress | undefined;
  /** False when the QBD row is marked HIDDEN=Y (made inactive in QBD). */
  isActive: boolean;
}

export interface ParsedSplit {
  account: string;
  amount: string; // signed decimal string (e.g. "-250.0000")
  name?: string | undefined;
  memo?: string | undefined;
  classRef?: string | undefined;
}

export interface ParsedTransaction {
  /** Source row number (1-based) of the TRNS line, useful for error display. */
  rowNumber: number;
  /** Raw TRNSTYPE value: INVOICE, BILL, CHECK, etc. */
  qbType: string;
  /** Mapped sourceType for journal_entries.source_type. */
  sourceType:
    | 'invoice'
    | 'bill'
    | 'payment'
    | 'bank_transaction'
    | 'reconciliation'
    | 'payroll'
    | 'import'
    | 'manual';
  /** Whether this transaction posts to the GL or is a non-posting document
   * (estimates, sales orders, purchase orders). Non-posting are excluded. */
  posts: boolean;
  date: string; // YYYY-MM-DD
  docNum?: string | undefined;
  memo?: string | undefined;
  reference?: string | undefined;
  /** TRNS row + zero or more SPL rows, all with signed amounts. */
  lines: ParsedSplit[];
}

export interface ReferencedAccount {
  name: string;
  /** Suggested mapping inferred from name keywords. User can override in UI. */
  suggestedType: AccountType;
  suggestedSubtype: AccountSubtype;
  /** A 4-digit code suggestion in the right range for the suggested type. */
  suggestedCode: string;
  /** How many transactions reference this name (helps the user prioritise review). */
  occurrences: number;
}

export interface IifPreview {
  accounts: ParsedAccount[];
  customers: ParsedCustomer[];
  vendors: ParsedVendor[];
  transactions: ParsedTransaction[];
  /** Per-TRNSTYPE counts so the UI can summarise without iterating in JS. */
  transactionCounts: Record<string, number>;
  /** Non-posting transaction types we deliberately skipped. */
  nonPostingSkipped: number;
  /**
   * Account names referenced in TRNS/SPL rows but NOT defined in this file's
   * !ACCNT section AND not already in the company's chart of accounts.
   * Caller can include these (with possibly-edited type/subtype) in the
   * commit accounts array to have them auto-created before transactions post.
   */
  missingAccounts: ReferencedAccount[];
  /** Lines we couldn't classify -- shown so the user knows what was ignored. */
  unrecognizedSections: string[];
  /** Parser warnings (unmapped account types, malformed rows, etc.). */
  warnings: string[];
  /**
   * Posting blocks excluded at parse time for data errors (out of balance,
   * fewer than 2 lines). They are counted in transactionCounts but never
   * enter `transactions`, so without this list the UI's per-type table would
   * mislabel them "skipped (non-posting)" and the final commit summary would
   * have no trace of them at all.
   */
  excludedTransactions: { rowNumber: number; qbType: string; reason: string }[];
}

// ------------------------- ACCNTTYPE map ------------------------------------

const ACCNT_TYPE_MAP: Record<string, { type: AccountType; subtype: AccountSubtype }> = {
  BANK: { type: 'asset', subtype: 'bank' },
  CCARD: { type: 'liability', subtype: 'credit_card' },
  AR: { type: 'asset', subtype: 'accounts_receivable' },
  AP: { type: 'liability', subtype: 'accounts_payable' },
  OCASSET: { type: 'asset', subtype: 'other_current_asset' },
  FIXASSET: { type: 'asset', subtype: 'fixed_asset' },
  OASSET: { type: 'asset', subtype: 'other_asset' },
  OCLIAB: { type: 'liability', subtype: 'other_current_liability' },
  OLIAB: { type: 'liability', subtype: 'long_term_liability' },
  LTLIAB: { type: 'liability', subtype: 'long_term_liability' },
  EQUITY: { type: 'equity', subtype: 'equity' },
  INC: { type: 'revenue', subtype: 'income' },
  OINC: { type: 'revenue', subtype: 'other_income' },
  EXP: { type: 'expense', subtype: 'expense' },
  COGS: { type: 'expense', subtype: 'cost_of_goods_sold' },
  EXEXP: { type: 'expense', subtype: 'other_expense' },
  EXINC: { type: 'revenue', subtype: 'other_income' },
};

const TYPE_CODE_PREFIX: Record<AccountType, number> = {
  asset: 1000,
  liability: 2000,
  equity: 3000,
  revenue: 4000,
  expense: 5000,
};

/**
 * Auto-plug ceiling for out-of-balance blocks: one cent, in 4dp micros. QBD
 * keeps single-currency ledgers penny-balanced, but multicurrency home-value
 * exports and hand-touched files can carry 1-cent drift -- dropping a
 * $12,000 deposit over $0.01 loses the whole transaction. Anything beyond a
 * cent is data corruption, not rounding: those blocks still exclude.
 */
const ROUNDING_PLUG_MAX_MICROS = 100n;
/** Account the auto-plug posts to. If the chart doesn't have it, it flows
 * through missingAccounts like any other referenced name, so the drift stays
 * visible and reviewable instead of silently vanishing into another line. */
const ROUNDING_ACCOUNT_NAME = 'Rounding';

/**
 * QB TRNSTYPE -> KPBooks journal source_type. Non-posting types map to
 * `posts: false` so we skip them entirely (estimates, sales orders, purchase
 * orders, item receipts that are also booked separately as a BILL, etc.).
 */
const TRNSTYPE_MAP: Record<
  string,
  { sourceType: ParsedTransaction['sourceType']; posts: boolean }
> = {
  INVOICE: { sourceType: 'invoice', posts: true },
  'CASH SALE': { sourceType: 'invoice', posts: true },
  CASHSALE: { sourceType: 'invoice', posts: true },
  'CREDIT MEMO': { sourceType: 'invoice', posts: true },
  CREDMEMO: { sourceType: 'invoice', posts: true },
  BILL: { sourceType: 'bill', posts: true },
  'BILL REFUND': { sourceType: 'bill', posts: true },
  'VENDOR CREDIT': { sourceType: 'bill', posts: true },
  VENDCRED: { sourceType: 'bill', posts: true },
  PAYMENT: { sourceType: 'payment', posts: true },
  RCPT: { sourceType: 'payment', posts: true },
  'BILL PMT-CHECK': { sourceType: 'payment', posts: true },
  BILLPMT: { sourceType: 'payment', posts: true },
  'BILL PMT-CCARD': { sourceType: 'payment', posts: true },
  CHECK: { sourceType: 'bank_transaction', posts: true },
  CHK: { sourceType: 'bank_transaction', posts: true },
  DEPOSIT: { sourceType: 'bank_transaction', posts: true },
  DEP: { sourceType: 'bank_transaction', posts: true },
  TRANSFER: { sourceType: 'bank_transaction', posts: true },
  XFER: { sourceType: 'bank_transaction', posts: true },
  'CREDIT CARD CHARGE': { sourceType: 'bank_transaction', posts: true },
  'CCARD CHARGE': { sourceType: 'bank_transaction', posts: true },
  // Real QBD credit-card-charge exports often use bare "CCARD"; Intuit's IIF
  // reference documents plain "CREDIT CARD" for the same transaction.
  CCARD: { sourceType: 'bank_transaction', posts: true },
  'CREDIT CARD': { sourceType: 'bank_transaction', posts: true },
  'CREDIT CARD CREDIT': { sourceType: 'bank_transaction', posts: true },
  'CCARD CREDIT': { sourceType: 'bank_transaction', posts: true },
  'CCARD REFUND': { sourceType: 'bank_transaction', posts: true },
  // Refund on a cash sale -- the money-out counterpart of CASH SALE.
  'CASH REFUND': { sourceType: 'invoice', posts: true },
  'GENERAL JOURNAL': { sourceType: 'manual', posts: true },
  'GEN JRNL': { sourceType: 'manual', posts: true },
  GENJRNL: { sourceType: 'manual', posts: true },
  PAYCHECK: { sourceType: 'payroll', posts: true },
  'PAY CHECK': { sourceType: 'payroll', posts: true },
  'LIABILITY CHECK': { sourceType: 'payroll', posts: true },
  LIABCHECK: { sourceType: 'payroll', posts: true },
  'INVENTORY ADJUST': { sourceType: 'manual', posts: true },
  INVADJUST: { sourceType: 'manual', posts: true },
  'ITEM RECEIPT': { sourceType: 'bill', posts: true },
  ITEMRCPT: { sourceType: 'bill', posts: true },
  // Non-posting documents. Intuit's documented IIF keywords are the PLURAL
  // forms (ESTIMATES, SALES ORDERS, PURCHASE ORDERS); the singulars are kept
  // for hand-built files. The normalised fallback strips only spaces/hyphens,
  // so it cannot bridge singular/plural -- a missing plural here would fall
  // through to the posts:true default and book fabricated P&L activity.
  ESTIMATE: { sourceType: 'import', posts: false },
  ESTIMATES: { sourceType: 'import', posts: false },
  'SALES ORDER': { sourceType: 'import', posts: false },
  'SALES ORDERS': { sourceType: 'import', posts: false },
  'PURCHASE ORDER': { sourceType: 'import', posts: false },
  'PURCHASE ORDERS': { sourceType: 'import', posts: false },
  PURCHORD: { sourceType: 'import', posts: false },
  SALESORD: { sourceType: 'import', posts: false },
  STATEMENT: { sourceType: 'import', posts: false },
};

/**
 * Secondary lookup keyed with spaces/hyphens stripped. Real QBD exports vary
 * spelling by version ("BILLPMT -CHECK" vs "BILL PMT-CHECK"), so before
 * falling back to the generic 'import' mapping we retry with whitespace and
 * hyphens removed. All colliding keys in TRNSTYPE_MAP map to identical
 * values (e.g. "CASH SALE"/"CASHSALE"), so last-write-wins is safe here.
 */
const TRNSTYPE_MAP_NORMALISED: Record<
  string,
  { sourceType: ParsedTransaction['sourceType']; posts: boolean }
> = Object.fromEntries(
  Object.entries(TRNSTYPE_MAP).map(([k, v]) => [k.replace(/[\s-]+/g, ''), v]),
);

function lookupTrnsType(
  raw: string,
): { sourceType: ParsedTransaction['sourceType']; posts: boolean } {
  const upper = raw.trim().toUpperCase();
  return (
    TRNSTYPE_MAP[upper] ??
    TRNSTYPE_MAP_NORMALISED[upper.replace(/[\s-]+/g, '')] ??
    { sourceType: 'import', posts: true }
  );
}

/** True when (year, month, day) is a real calendar date -- rejects 2/30,
 * 4/31, and 2/29 in non-leap years, which a plain 1-31 bounds check lets
 * through. Postgres would reject such a value later with an opaque error
 * that aborts the whole import transaction, so it must die here. */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Calendar-validate an already-shaped "YYYY-MM-DD" string. */
function isRealIsoDate(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m !== null && isRealCalendarDate(+m[1]!, +m[2]!, +m[3]!);
}

/** Parse "01/15/2026" / "1/15/2026" / "01/15/26" / "2026-01-15" -> "YYYY-MM-DD".
 * Slash dates read month-first by default; pass dayFirst=true for files
 * detected as D/M/Y-locale exports (see the re-parse pass in parseIif). */
export function normaliseDate(raw: string, dayFirst = false): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isRealIsoDate(s) ? s : null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const month = parseInt(m[dayFirst ? 2 : 1]!, 10);
  const day = parseInt(m[dayFirst ? 1 : 2]!, 10);
  let year = parseInt(m[3]!, 10);
  if (m[3]!.length === 2) {
    // Two-digit years: 00-49 -> 2000s, 50-99 -> 1900s. QB exports are usually
    // recent; this matches QB's own convention.
    year = year < 50 ? 2000 + year : 1900 + year;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (!isRealCalendarDate(year, month, day)) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** Strip $ , spaces; map "(123.45)" -> "-123.45". Returns canonical 4dp string. */
export function normaliseAmount(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  // Accounting parens: (123.45) means negative.
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  // Strip currency symbol and spaces; commas are vetted below before removal.
  s = s.replace(/[$\s]/g, '');
  // A comma followed by 1-2 trailing digits is a DECIMAL comma ("1.234,56",
  // "1234,56", "1,50" -- continental-locale conversion tools; QBD's
  // supported US/CA/UK editions all write period decimals). Stripping it as
  // a thousands separator shifts the magnitude 100-1000x, and because every
  // line of a block shifts identically the block still balances and posts
  // silently wrong. Reject instead: the row fails loudly and the block is
  // excluded with a warning. Valid US grouping always has exactly 3 digits
  // after each comma, so this never rejects a genuine QBD amount.
  if (/,\d{1,2}$/.test(s)) return null;
  s = s.replace(/,/g, '');
  if (s.startsWith('-')) {
    // Inside accounting parens a leading minus is redundant confirmation of
    // the sign -- "(-250.00)" is negative 250. Toggling here read it as
    // POSITIVE and imported such blocks with debit/credit inverted.
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  // Force 4 decimal places to match NUMERIC(19,4).
  const [whole = '0', frac = ''] = s.split('.');
  const padded = (frac + '0000').slice(0, 4);
  return `${negative ? '-' : ''}${whole}.${padded}`;
}

// ------------------------- Parser -------------------------------------------

/**
 * Split one IIF line into cells. QBD wraps fields containing commas, quotes,
 * or tabs in double quotes with `""` escaping, so a bare split('\t') stores
 * literal quote characters, rejects quoted amounts like "1,234.56", and lets
 * an embedded tab shift every later column. Only fields that START with a
 * quote are treated as quoted; everything else is taken verbatim.
 *
 * `problems` collects per-line parse complaints (currently only a never-closed
 * quote) so the caller can surface them as row warnings.
 */
export function splitIifLine(raw: string, problems?: string[]): string[] {
  const cells: string[] = [];
  let i = 0;
  for (;;) {
    if (raw[i] === '"') {
      // Quoted field: consume to the closing quote, honouring "" escapes.
      const openedAt = i;
      let value = '';
      let closed = false;
      i++;
      while (i < raw.length) {
        if (raw[i] === '"') {
          if (raw[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += raw[i];
        i++;
      }
      if (!closed) {
        // The quote is never closed on this line -- a bookkeeper's stray `"`
        // in a free-text NOTE/DESC/MEMO, or an Excel/Notepad round-trip.
        // Consuming to end-of-line made the rest of the row ONE cell, so
        // every later column silently read as empty: a VEND row lost its
        // 1099 flag, tax ID and terms, an ACCNT row lost HIDDEN and ACCNUM,
        // and the row still "parsed" with no warning anywhere. The tabs in
        // the remainder are real column separators, so re-read the cell as
        // unquoted (verbatim, stray quote and all) and every later field
        // survives.
        problems?.push(
          'unterminated quote (") -- the rest of the row was read as plain tab-separated text',
        );
        i = openedAt;
        const tab = raw.indexOf('\t', i);
        cells.push(raw.slice(i, tab === -1 ? raw.length : tab));
        if (tab === -1) return cells;
        i = tab + 1;
        continue;
      }
      // Keep any (malformed) trailing chars before the tab rather than lose data.
      const tab = raw.indexOf('\t', i);
      cells.push(value + raw.slice(i, tab === -1 ? raw.length : tab));
      if (tab === -1) return cells;
      i = tab + 1;
    } else {
      const tab = raw.indexOf('\t', i);
      cells.push(raw.slice(i, tab === -1 ? raw.length : tab));
      if (tab === -1) return cells;
      i = tab + 1;
    }
  }
}

/**
 * Longest list-entity name we accept. Real QBD maxima are well below this
 * (account paths ~159 chars, customer:job paths ~209), so anything longer is
 * corrupt -- skip the row with a warning instead of letting the commit-time
 * schema reject the entire request.
 */
const MAX_NAME_LENGTH = 255;
/** journal memos are capped at 500 by the posting service; truncate to match. */
const MAX_MEMO_LENGTH = 500;

function truncateMemo(raw: string, rowNo: number, warnings: string[]): string | undefined {
  if (!raw) return undefined;
  if (raw.length <= MAX_MEMO_LENGTH) return raw;
  warnings.push(`row ${rowNo}: memo longer than ${MAX_MEMO_LENGTH} chars; truncated`);
  return raw.slice(0, MAX_MEMO_LENGTH);
}

/**
 * CommitCustomer/CommitVendor cap phone and taxId at 40 chars. QBD's own UI
 * stays well under that, but hand-edited and conversion-tool files carry
 * notes in those cells ("(512) 555-1234 ext. 4471 / cell ..."), and an
 * over-cap value that sailed through preview would 400 the ENTIRE commit
 * with a ZodError -- taking every other row in the chunk and the whole
 * transactions leg with it. Truncate loudly instead (mirrors the ACCNUM cap
 * and sanitiseEmail); a silently shortened 1099 TIN would be worse than a
 * noisy one.
 */
const MAX_CONTACT_FIELD_LENGTH = 40;

function truncateContactField(
  raw: string,
  rowNo: number,
  label: string,
  field: string,
  warnings: string[],
): string | undefined {
  if (!raw) return undefined;
  if (raw.length <= MAX_CONTACT_FIELD_LENGTH) return raw;
  warnings.push(
    `row ${rowNo}: ${label} ${field} "${raw}" is longer than ${MAX_CONTACT_FIELD_LENGTH} chars; truncated`,
  );
  return raw.slice(0, MAX_CONTACT_FIELD_LENGTH);
}

const EmailCheck = z.string().email().max(200);

/**
 * QB's e-mail field is free text: it routinely holds several addresses
 * ("ap@acme.com;billing@acme.com") or notes. Keep the first valid address so
 * one messy field can't invalidate the whole row; warn about what was dropped.
 */
function sanitiseEmail(
  raw: string,
  rowNo: number,
  label: string,
  warnings: string[],
): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  if (EmailCheck.safeParse(s).success) return s;
  const valid = s.split(/[;,\s]+/).find((c) => c && EmailCheck.safeParse(c).success);
  if (valid) {
    warnings.push(`row ${rowNo}: ${label} email "${s}" holds multiple values; keeping "${valid}"`);
    return valid;
  }
  warnings.push(`row ${rowNo}: ${label} email "${s}" is not a valid address; importing without email`);
  return undefined;
}

/**
 * Friendly labels for list sections we recognise but don't import (yet). A
 * full QBD lists export also carries OTHERNAME, TERMS, PAYMETH, etc. --
 * every unhandled section is surfaced (unknown tags pass through raw) so
 * users never assume records came over when they were dropped.
 */
const SECTION_FRIENDLY_NAMES: Record<string, string> = {
  INVITEM: 'inventory items',
  EMP: 'employees',
  CLASS: 'classes',
  TIMEACT: 'time activities',
  OTHERNAME: 'other names',
  TERMS: 'payment terms',
  PAYMETH: 'payment methods',
  SHIPMETH: 'shipping methods',
  CTYPE: 'customer types',
  CUSTTYPE: 'customer types',
  VTYPE: 'vendor types',
  VENDTYPE: 'vendor types',
  INVMEMO: 'customer messages',
  SALESTAXCODE: 'sales tax codes',
  BUD: 'budgets',
  TODO: 'to-do notes',
};

export function parseIif(
  text: string,
  opts?: { dateOrder?: 'mdy' | 'dmy' },
): IifPreview {
  const dayFirst = opts?.dateOrder === 'dmy';
  const accounts: ParsedAccount[] = [];
  const customers: ParsedCustomer[] = [];
  const vendors: ParsedVendor[] = [];
  const transactions: ParsedTransaction[] = [];
  const transactionCounts: Record<string, number> = {};
  let nonPostingSkipped = 0;
  const unrecognizedSections: string[] = [];
  const warnings: string[] = [];
  const excludedTransactions: IifPreview['excludedTransactions'] = [];
  const seenSections = new Set<string>();
  // Rows whose first cell isn't a section tag we can even name (lower-cased
  // tags from a conversion tool, a spreadsheet's "Total assets" summary row).
  // Aggregated per distinct tag so a whole-file corruption reports one line
  // instead of one per row -- see the disclosure after the loop.
  const unknownTagRows = new Map<string, { count: number; firstRow: number }>();
  // How many ACCNT rows carry a non-zero QBD opening balance (OBAMOUNT).
  // Never imported -- see parseAccountRow -- but counted so a lists-only file
  // can say where the balances actually are.
  const obStats = { withOpeningBalance: 0 };

  // Maps section tag -> column index map.
  const headers: Record<string, Record<string, number>> = {};

  // TRNS+SPL+ENDTRNS state machine.
  let pendingTransaction: ParsedTransaction | null = null;
  // True while inside a block whose TRNS row itself failed parsing (bad
  // date/amount, missing ACCNT/TRNSTYPE). The block is already tracked in
  // transactionCounts + excludedTransactions at the TRNS row, so its SPL
  // rows are swallowed without the per-row "outside a TRNS block" noise.
  let inExcludedBlock = false;
  // Date-order evidence gathered while parsing (only in the default M/D/Y
  // pass): a rejected date shaped like day-first is D/M/Y-locale evidence, a
  // parsed date with day 13-31 proves M/D/Y, and a parsed date with both
  // components <= 12 proves nothing. Drives the re-parse / warnings after
  // the loop.
  const dateStats = { dayFirstDates: 0, monthFirstDates: 0, ambiguousDates: 0, example: '' };

  const finalisePending = (rowNo: number) => {
    if (!pendingTransaction) return;
    const { qbType, posts } = pendingTransaction;
    transactionCounts[qbType] = (transactionCounts[qbType] ?? 0) + 1;
    if (posts && pendingTransaction.lines.length >= 2) {
      // Balance check at parse time. An unbalanced block (rounding drift,
      // truncated split rows) would otherwise sail through the preview and
      // only be dropped at commit -- after the user has confirmed -- leaving
      // the imported bank balance off from the real statement with no chance
      // to fix the file first.
      const imbalance = pendingTransaction.lines.reduce(
        (acc, l) => acc + signedAmountToMicros(l.amount),
        0n,
      );
      const absImbalance = imbalance < 0n ? -imbalance : imbalance;
      if (imbalance === 0n) {
        transactions.push(pendingTransaction);
      } else if (absImbalance <= ROUNDING_PLUG_MAX_MICROS) {
        // Penny drift (multicurrency home-value exports, hand-edited files):
        // post the block with an explicit Rounding line instead of dropping
        // it whole. The entry still nets to exactly zero -- the plug is a
        // real, visible journal line -- so balance enforcement is not
        // relaxed, and the warning points the user at the Rounding account.
        pendingTransaction.lines.push({
          account: ROUNDING_ACCOUNT_NAME,
          amount: microsToDecimal(-imbalance),
          name: undefined,
          memo: 'rounding adjustment added at import',
          classRef: undefined,
        });
        warnings.push(
          `row ${pendingTransaction.rowNumber}: ${qbType} block is out of balance by ` +
            `${microsToDecimal(imbalance)} (debits minus credits); a "${ROUNDING_ACCOUNT_NAME}" ` +
            `line was added so it can post -- review the ${ROUNDING_ACCOUNT_NAME} account after import`,
        );
        transactions.push(pendingTransaction);
      } else {
        warnings.push(
          `row ${pendingTransaction.rowNumber}: ${qbType} block is out of balance by ` +
            `${microsToDecimal(imbalance)} (debits minus credits); it will NOT be imported -- ` +
            `fix the amounts and re-import`,
        );
        excludedTransactions.push({
          rowNumber: pendingTransaction.rowNumber,
          qbType,
          reason: `out of balance by ${microsToDecimal(imbalance)} (debits minus credits)`,
        });
      }
    } else if (!posts) {
      nonPostingSkipped++;
    } else {
      // posting type but <2 lines: malformed.
      warnings.push(
        `row ${rowNo}: ${qbType} block has only ${pendingTransaction.lines.length} line(s); skipping`,
      );
      excludedTransactions.push({
        rowNumber: pendingTransaction.rowNumber,
        qbType,
        reason: `block has only ${pendingTransaction.lines.length} line(s)`,
      });
    }
    pendingTransaction = null;
  };

  // Editors that re-save an IIF as "UTF-8 with BOM" prepend U+FEFF; when the
  // upload path falls back to windows-1252 those same bytes decode as "ï»¿".
  // Either way the first header row would fail startsWith('!') and the whole
  // first section would be silently dropped. Lone \r (legacy/mixed line
  // endings) is normalised too so a stray carriage return can't hide in a cell.
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/^ï»¿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (!raw.trim()) continue;
    const lineProblems: string[] = [];
    const cells = splitIifLine(raw, lineProblems);
    for (const p of lineProblems) warnings.push(`row ${i + 1}: ${p}`);
    // Trimmed to match the header-column path below: a single leading or
    // trailing space (hand-edited files, spreadsheet round-trips) otherwise
    // made the whole row unrecognizable and it was dropped without a trace.
    const tag = (cells[0] ?? '').trim();

    if (tag.startsWith('!')) {
      // Header row. Build column map for this section.
      const sectionTag = tag.slice(1);
      const colMap: Record<string, number> = {};
      for (let c = 1; c < cells.length; c++) {
        const colName = (cells[c] ?? '').trim();
        if (colName) colMap[colName] = c;
      }
      headers[sectionTag] = colMap;
      continue;
    }

    // A data row whose first cell is empty still carries real content in the
    // later cells -- a line of nothing but tabs/spaces was already consumed by
    // the !raw.trim() guard above -- so the usual cause is a spreadsheet
    // round-trip that shifted one row a column left. Dropping it without a
    // trace was the one hole in this module's "nothing disappears silently"
    // contract, so route it through the same aggregation the unknown-tag rows
    // use rather than one warning per row.
    if (!tag) {
      const blank = unknownTagRows.get('');
      if (blank) blank.count++;
      else unknownTagRows.set('', { count: 1, firstRow: i + 1 });
      continue;
    }

    if (tag === 'ACCNT') {
      const cols = headers.ACCNT;
      if (!cols) {
        warnings.push(`row ${i + 1}: ACCNT row before ACCNT header; skipping`);
        continue;
      }
      const account = parseAccountRow(cells, cols, i + 1, warnings, obStats);
      if (account) accounts.push(account);
      continue;
    }

    if (tag === 'CUST') {
      const cols = headers.CUST;
      if (!cols) {
        warnings.push(`row ${i + 1}: CUST row before CUST header; skipping`);
        continue;
      }
      const cust = parseCustomerRow(cells, cols, i + 1, warnings);
      if (cust) customers.push(cust);
      continue;
    }

    if (tag === 'VEND') {
      const cols = headers.VEND;
      if (!cols) {
        warnings.push(`row ${i + 1}: VEND row before VEND header; skipping`);
        continue;
      }
      const v = parseVendorRow(cells, cols, i + 1, warnings);
      if (v) vendors.push(v);
      continue;
    }

    if (tag === 'TRNS') {
      const cols = headers.TRNS;
      if (!cols) {
        warnings.push(`row ${i + 1}: TRNS row before TRNS header; skipping`);
        // Track the block structurally, exactly like the TRNS-parse-failure
        // branch below. Without the header the TRNSTYPE column position is
        // unknown, so it counts as UNKNOWN -- the same shape parseTrnsRow
        // uses for a TRNS row carrying no TRNSTYPE. A free-text warning alone
        // left the preview's per-type table and the completion screen reading
        // "0 skipped / 0 excluded" while the bank register came up short.
        transactionCounts.UNKNOWN = (transactionCounts.UNKNOWN ?? 0) + 1;
        excludedTransactions.push({
          rowNumber: i + 1,
          qbType: 'UNKNOWN',
          reason: 'TRNS row appeared before its !TRNS header row, so the block could not be read',
        });
        // Its SPL rows belong to a block that is already accounted for.
        inExcludedBlock = true;
        continue;
      }
      // Implicit ENDTRNS for any pending transaction without one.
      if (pendingTransaction) {
        warnings.push(`row ${i + 1}: TRNS encountered while previous block had no ENDTRNS`);
        finalisePending(i + 1);
      }
      const parsed = parseTrnsRow(cells, cols, i + 1, warnings, dateStats, dayFirst);
      if ('failed' in parsed) {
        // The block's header row is unusable, so nothing can post -- but the
        // block must still be tracked structurally (transactionCounts +
        // excludedTransactions, or nonPostingSkipped for non-posting types),
        // exactly like out-of-balance blocks. A free-text warning alone
        // leaves the preview's counts and the post-commit screen reading
        // "0 skipped / 0 excluded" while the register is silently short.
        transactionCounts[parsed.qbType] = (transactionCounts[parsed.qbType] ?? 0) + 1;
        if (parsed.posts) {
          excludedTransactions.push({
            rowNumber: i + 1,
            qbType: parsed.qbType,
            reason: parsed.reason,
          });
        } else {
          nonPostingSkipped++;
        }
        pendingTransaction = null;
        inExcludedBlock = true;
        continue;
      }
      pendingTransaction = parsed;
      inExcludedBlock = false;
      continue;
    }

    if (tag === 'SPL') {
      const cols = headers.SPL;
      if (!cols) {
        warnings.push(`row ${i + 1}: SPL row before SPL header; skipping`);
        continue;
      }
      if (!pendingTransaction) {
        // Splits of a block whose TRNS row failed parsing are accounted for
        // by that block's excludedTransactions entry -- don't emit one noisy
        // warning per orphaned split on top of it.
        if (!inExcludedBlock) {
          warnings.push(`row ${i + 1}: SPL row outside a TRNS block; skipping`);
        }
        continue;
      }
      const split = parseSplRow(cells, cols, i + 1, warnings);
      if (split) pendingTransaction.lines.push(split);
      continue;
    }

    if (tag === 'ENDTRNS') {
      finalisePending(i + 1);
      inExcludedBlock = false;
      continue;
    }

    if (tag === 'HDR') {
      // !HDR/HDR is the version stamp (PROD/VER/REL/IIFVER metadata) at the
      // top of every real QBD transaction export. It carries no records, so
      // surfacing it in unrecognizedSections rendered "Skipped (not yet
      // supported): HDR" on every genuine export -- implying data was
      // dropped when nothing was.
      continue;
    }

    // Track unrecognized but valid-looking section tags so the user can see
    // what got dropped (e.g., INVITEM, CLASS, EMP).
    if (/^[A-Z][A-Z0-9_]*$/.test(tag)) {
      seenSections.add(tag);
      continue;
    }
    // Everything else is a row being dropped. The regex filter above stays --
    // listing junk like "Total assets" as a skipped SECTION would be its own
    // lie -- but the drop still has to be disclosed: a file whose tags were
    // lower-cased by a conversion tool used to import as zero records with an
    // empty warnings list and an empty "skipped" list, which is exactly the
    // silent loss this module promises never to do.
    const known = unknownTagRows.get(tag);
    if (known) known.count++;
    else unknownTagRows.set(tag, { count: 1, firstRow: i + 1 });
  }

  // Flush a trailing transaction if the file ended without ENDTRNS.
  if (pendingTransaction) {
    warnings.push('file ended with an unclosed TRNS block (no ENDTRNS)');
    finalisePending(lines.length);
  }

  for (const tag of seenSections) {
    const friendly = SECTION_FRIENDLY_NAMES[tag] ?? tag;
    if (!unrecognizedSections.includes(friendly)) unrecognizedSections.push(friendly);
  }

  for (const [tag, info] of unknownTagRows) {
    if (tag === '') {
      warnings.push(
        `${info.count} row(s) have an empty first column (first at row ${info.firstRow}); ` +
          `those rows were skipped -- every IIF row starts with its section tag ` +
          `(ACCNT, CUST, TRNS), so this usually means the row was shifted a column ` +
          `when the file was edited or converted after it was exported`,
      );
      continue;
    }
    const label = tag.length > 40 ? `${tag.slice(0, 40)}...` : tag;
    warnings.push(
      `unrecognized row type "${label}" on ${info.count} row(s) (first at row ${info.firstRow}); ` +
        `those rows were skipped -- QuickBooks writes section tags in capitals (ACCNT, CUST, TRNS), ` +
        `so this usually means the file was edited or converted after it was exported`,
    );
  }

  // QBD's "Lists to IIF" export carries each account's opening balance in
  // OBAMOUNT, and we deliberately never import it (QuickBooks records those
  // balances as real transactions against Opening Balance Equity, which come
  // over with the TRANSACTIONS export -- importing both would double-book
  // every one). Say so, or a customer who runs only the documented first step
  // gets a complete chart of accounts, zero warnings, and no hint that the
  // balances are still sitting in the other file.
  if (accounts.length > 0 && transactions.length === 0 && obStats.withOpeningBalance > 0) {
    warnings.push(
      `${obStats.withOpeningBalance} account(s) in this file carry a QuickBooks opening balance ` +
        `(OBAMOUNT), and this file has no transactions. Opening balances are NOT imported from a ` +
        `lists file -- QuickBooks records them as transactions -- so the accounts will start at ` +
        `zero until you also import your transactions IIF export.`,
    );
  }

  // IIF DATE fields follow the exporting machine's Windows short-date locale.
  // A TRNS date that fails the month check with a plausible day-first shape
  // (e.g. "25/05/2026") is D/M/Y-locale evidence; a parsed date whose second
  // component is 13-31 proves M/D/Y. When every readable slash date says
  // day-first and nothing says month-first, the file IS a D/M/Y export:
  // re-read the whole file day-first so every date lands in the right month,
  // instead of dropping the day-13+ rows and silently transposing the rest
  // (a check dated 05/03 would otherwise post to May instead of March).
  if (!dayFirst && dateStats.dayFirstDates > 0 && dateStats.monthFirstDates === 0) {
    const reparsed = parseIif(text, { dateOrder: 'dmy' });
    reparsed.warnings.unshift(
      `TRNS dates in this file look like day/month/year (e.g. "${dateStats.example}"), so ALL ` +
        `dates were read as day/month/year. Verify a sample transaction's date in the preview ` +
        `before confirming; to keep files unambiguous, re-export from QuickBooks on a machine ` +
        `with US (M/D/YYYY) regional date settings.`,
    );
    return reparsed;
  }
  if (!dayFirst && dateStats.dayFirstDates > 0) {
    // Mixed evidence: some dates prove month-first, others look day-first.
    // The day-first-shaped rows were dropped per-row above; the file itself
    // is corrupt, so no re-parse can fix it.
    warnings.push(
      `${dateStats.dayFirstDates} TRNS date(s) look like day/month/year (e.g. "${dateStats.example}") ` +
        `but other dates in this file are unambiguously month/day/year. KPBooks reads IIF dates as ` +
        `month/day/year (M/D/YYYY); the day/month/year-shaped rows were skipped -- check the file ` +
        `for corrupt dates and re-import.`,
    );
  } else if (!dayFirst && dateStats.monthFirstDates === 0 && dateStats.ambiguousDates > 0) {
    // Every slash date in the file has day <= 12: nothing in the data can
    // prove the order, and a D/M/Y-locale export would import with every
    // date transposed and ZERO other warnings. Say so while the user can
    // still check a sample transaction against QuickBooks.
    warnings.push(
      `Every transaction date in this file has a day of 12 or lower, so month/day order cannot ` +
        `be verified from the data. Dates were read as month/day/year (US, M/D/YYYY). If this ` +
        `file was exported on a machine with day/month/year regional settings, every date is ` +
        `transposed -- verify a sample transaction's date against QuickBooks before confirming.`,
    );
  }

  // Assign suggested codes after all accounts parsed so we can group by type.
  // Accounts with a real QBD number (ACCNUM) keep it -- fabricating codes
  // would renumber the customer's entire chart. Synthetic codes fill the
  // gaps, stepping over file-provided numbers so an import can't collide
  // with itself.
  const usedCodes = new Set(accounts.map((a) => a.suggestedCode).filter(Boolean));
  const counters: Record<AccountType, number> = {
    asset: 0,
    liability: 0,
    equity: 0,
    revenue: 0,
    expense: 0,
  };
  for (const a of accounts) {
    if (a.suggestedCode) continue;
    let code: string;
    do {
      counters[a.type]++;
      code = String(TYPE_CODE_PREFIX[a.type] + counters[a.type] * 10);
    } while (usedCodes.has(code));
    a.suggestedCode = code;
    usedCodes.add(code);
  }

  // Transactions that reference a HIDDEN (inactive-in-QBD) account will be
  // skipped per-row at commit -- the posting service refuses inactive
  // accounts. Surface that at preview, while the user can still plan around
  // it, instead of springing per-row errors on the completion screen.
  const hiddenNames = new Set(
    accounts.filter((a) => !a.isActive).map((a) => a.name.toLowerCase()),
  );
  if (hiddenNames.size > 0 && transactions.length > 0) {
    const affected = transactions.filter((t) =>
      t.lines.some((l) => hiddenNames.has(l.account.toLowerCase())),
    ).length;
    if (affected > 0) {
      warnings.push(
        `${affected} transaction(s) reference account(s) marked inactive (HIDDEN=Y) in this ` +
          `file's account list and will be skipped at import. To post that history: re-activate ` +
          `the account(s), re-import this file (already-posted transactions are skipped as ` +
          `duplicates), then de-activate them again.`,
      );
    }
  }

  return {
    accounts,
    customers,
    vendors,
    transactions,
    transactionCounts,
    nonPostingSkipped,
    missingAccounts: [], // populated by the API layer (needs DB access)
    unrecognizedSections,
    warnings,
    excludedTransactions,
  };
}

/**
 * Expense-side qualifiers that must beat a balance-sheet or income keyword
 * found elsewhere in the same account name. QBD's stock chart is full of
 * names that pair a noun this heuristic keys on with an expense qualifier --
 * "Bank Service Charges", "Credit Card Processing Fees", "Auto and Truck
 * Expenses", "Payroll Service Fees", "Cost of Sales" -- and every one of them
 * belongs on the P&L. The payroll rule below has always carried a guard of
 * this shape; the credit-card, fixed-asset and income rules did not, which is
 * how stock QBD EXPENSE accounts ended up as balance-sheet accounts (net
 * income overstated by the whole balance) or as revenue (revenue and expenses
 * both understated, so neither ties to the QuickBooks P&L).
 */
// "discount" is deliberately absent: QBD's "Sales Discounts" is a
// contra-REVENUE account that belongs in the income section, and the fee
// accounts it would have caught ("Amex Discount Fees") are already fee-worded.
const EXPENSE_WORDED = /\b(expenses?|cost of|charges?|fees?|processing|penalt(?:y|ies))\b/;

/**
 * Extra expense wording specific to the fixed-asset rule: names that mention
 * the asset but describe the cost of running it ("Equipment Rental", "Vehicle
 * Repairs & Maintenance", "Truck Fuel", "Small Tools and Equipment"). These
 * are operating expenses -- capitalising them overstates total assets AND net
 * income by the full balance, and puts accounts holding pure expense into the
 * fixed-asset section of the balance sheet with no depreciation schedule.
 */
const ASSET_USE_EXPENSE_WORDED =
  /\b(rentals?|rent|repairs?|maintenance|insurance|fuel|gas|lease[sd]?|supplies|mileage|registration|parts|tools?)\b/;

/**
 * Heuristic: guess (type, subtype) from an account name. Used when an IIF
 * transaction references an account that isn't in the company's chart of
 * accounts AND wasn't included in the file's own !ACCNT section.
 *
 * Order matters -- more specific patterns first. The user can override the
 * suggestion in the preview UI before committing.
 */
export function inferAccountType(name: string): {
  type: AccountType;
  subtype: AccountSubtype;
} {
  const n = name.toLowerCase();

  // Bank-like.
  if (/\b(checking|savings|money market|petty cash|cash on hand|operating account)\b/.test(n)) {
    return { type: 'asset', subtype: 'bank' };
  }
  // A dedicated payroll bank account is standard for the payroll clients this
  // platform serves, and its name often carries none of the tokens above
  // ("Payroll Account", "Payroll Bank Account", "Payroll Cash"). Those fell
  // through to the payroll rule below and were created as Other Current
  // Liabilities: cash understated by the payroll balance, the liability
  // section negative by the same amount, and the account absent from the
  // bank-reconciliation picker (which lists bank/credit-card subtypes only),
  // so it could never be reconciled. Expense wording still wins ("Payroll
  // Service Fees"), as does explicit liability wording ("Payroll Liabilities",
  // "Payroll Taxes Payable") and the wage/tax expense accounts.
  if (
    /\bpayroll\b/.test(n) &&
    /\b(bank|account|acct|cash)\b/.test(n) &&
    !EXPENSE_WORDED.test(n) &&
    !/\b(liabilit(?:y|ies)|payable|withholding|wages?|salar(?:y|ies)|tax(?:es)?)\b/.test(n)
  ) {
    return { type: 'asset', subtype: 'bank' };
  }
  // Credit card / line-of-credit. Merchant-processing EXPENSE accounts carry
  // the same card tokens ("Credit Card Processing Fees", "Visa Merchant
  // Fees", "Amex Discount Fees") but belong on the P&L: created as a card
  // LIABILITY they carry a debit (contra) balance on the balance sheet and
  // mis-bucket into operating cash flow.
  // "Charge card" / "charge account" name the same LIABILITY -- they are not
  // fee wording -- but the bare `charges?` token in EXPENSE_WORDED vetoed the
  // rule and "AMEX Charge Card" fell all the way to the expense default: the
  // card balance lands on the P&L instead of the balance sheet and the
  // account never appears in the bank-reconciliation picker (bank/credit_card
  // subtypes only), so the card can never be reconciled. The phrase is
  // stripped before the guard rather than dropped from it, so genuine
  // merchant-fee names ("Amex Discount Fees", "Charge Card Fees") still lose.
  const cardName = n.replace(/\bcharge\s+(card|account)\b/g, ' ');
  if (
    /\b(credit card|charge card|charge account|ccard|visa|amex|mastercard|discover)\b/.test(n) &&
    !EXPENSE_WORDED.test(cardName)
  ) {
    return { type: 'liability', subtype: 'credit_card' };
  }
  // A/R + A/P (specific phrases first to avoid false positives).
  if (/\b(accounts? receivable|a\/r)\b/.test(n) && !/payable/.test(n)) {
    return { type: 'asset', subtype: 'accounts_receivable' };
  }
  if (/\b(accounts? payable|a\/p)\b/.test(n) && !/receivable/.test(n)) {
    return { type: 'liability', subtype: 'accounts_payable' };
  }
  // Receivable-side balances that aren't the A/R control account ("Loan
  // Receivable", "Interest Receivable") belong on the asset side -- checked
  // before the loan/liability patterns so they can't be flipped into debt.
  if (/\breceivables?\b/.test(n) && !/payable/.test(n)) {
    return { type: 'asset', subtype: 'other_current_asset' };
  }
  // Explicit liability wording always wins (Payroll Liabilities, Wages
  // Payable, Federal Withholding).
  if (/\b(liabilit(?:y|ies)|payable|withholding)\b/.test(n)) {
    if (/long.?term|note|loan|mortgage/.test(n)) {
      return { type: 'liability', subtype: 'long_term_liability' };
    }
    return { type: 'liability', subtype: 'other_current_liability' };
  }
  // "sales tax" / "payroll" suggest a liability only when the name isn't
  // expense-worded: QBD's default payroll EXPENSE accounts ("Payroll
  // Expenses", "Payroll Tax Expense", "Payroll Expenses:Wages") are on every
  // payroll-enabled company file and must stay on the P&L. Fee/charge/penalty
  // wording counts too ("Payroll Service Fees", "Sales Tax Penalties" are
  // costs we pay, not amounts we owe a taxing authority).
  if (
    /\b(sales tax|payroll)\b/.test(n) &&
    !EXPENSE_WORDED.test(n) &&
    !/\b(wages?|salar(?:y|ies))\b/.test(n)
  ) {
    return { type: 'liability', subtype: 'other_current_liability' };
  }
  if (/\b(loan|mortgage|note payable)\b/.test(n)) {
    return { type: 'liability', subtype: 'long_term_liability' };
  }
  // Fixed assets. Handle common plurals. Names that only MENTION the asset
  // while describing what it costs to run ("Auto and Truck Expenses",
  // "Equipment Rental", "Vehicle Insurance", "Computer and Internet
  // Expenses" -- all stock QBD accounts) stay on the P&L.
  if (
    /\b(equipment|vehicles?|trucks?|machinery|buildings?|furniture|fixtures?|land|computers?)\b/.test(n) &&
    !EXPENSE_WORDED.test(n) &&
    !ASSET_USE_EXPENSE_WORDED.test(n)
  ) {
    return { type: 'asset', subtype: 'fixed_asset' };
  }
  // Contra fixed-asset accounts: "Accumulated Depreciation" / "Accumulated
  // Amortization" sit on virtually every QBD balance sheet. Must be decided
  // before the other-expense rule below, whose bare "depreciation" /
  // "amortization" alternatives would land the contra-asset on the P&L --
  // netting the annual depreciation JE to zero and leaving the balance
  // sheet with fixed assets but no accumulated depreciation.
  if (/\baccum(?:ulated)?\.?\s+(depreciation|amortization|amortisation|depletion)\b/.test(n)) {
    return { type: 'asset', subtype: 'fixed_asset' };
  }
  // Deposits HELD from customers are money we owe back: QBD's standard
  // "Customer Deposits" / "Client Deposits" accounts are Other Current
  // Liabilities. Checked before the generic deposit pattern below, which
  // keeps catching deposits we PAID ("Deposits on Purchases", "Security
  // Deposit" paid to a landlord) and Undeposited Funds on the asset side.
  if (/\b(customer|client|tenant)s?'?s?\s+deposits?\b/.test(n) || /\bdeposits?\s+held\b/.test(n)) {
    return { type: 'liability', subtype: 'other_current_liability' };
  }
  // Deferred / unearned revenue is cash collected before it is earned -- QBD
  // types these OCLIAB. Decided before the income rule below, whose bare
  // "revenue"/"income" token otherwise files a prepaid-maintenance LIABILITY
  // in the revenue section of the P&L: net income and taxable revenue
  // overstated by the whole balance, the liability missing from the balance
  // sheet, and no way to correct the type after commit. Only names that also
  // carry revenue/income/rent/subscription wording qualify, so genuine
  // deferred ASSETS ("Deferred Tax Asset", "Deferred Charges") are untouched,
  // and expense wording still wins ("Deferred Income Tax Expense").
  if (
    (/\b(deferred|unearned)\b/.test(n) &&
      /\b(revenue|income|rent|subscriptions?|dues|fees?)\b/.test(n) &&
      !EXPENSE_WORDED.test(n)) ||
    /\b(customer|client)s?'?s?\s+prepayments?\b/.test(n) ||
    /\bprepayments?\s+(?:from|by)\s+(?:customer|client)s?\b/.test(n)
  ) {
    return { type: 'liability', subtype: 'other_current_liability' };
  }
  // Share capital. QBD types these EQUITY and they sit on the chart of every
  // incorporated client, but the inventory rule below claims any name with a
  // bare "stock" token (meant for "Stock on Hand") and filed Common Stock as
  // a current ASSET -- total assets overstated and equity understated by the
  // whole share issuance, so the migrated balance sheet cannot tie to QBD.
  if (/\b(common|preferred|treasury|capital|share|membership)\s+stock\b/.test(n)) {
    return { type: 'equity', subtype: 'equity' };
  }
  // Inventory / WIP / prepaid -> other current asset.
  if (/\b(inventory|stock|wip|work in progress|prepaid|deposits?|undeposited)\b/.test(n)) {
    return { type: 'asset', subtype: 'other_current_asset' };
  }
  // Equity.
  if (/\b(retained earnings)\b/.test(n)) {
    return { type: 'equity', subtype: 'retained_earnings' };
  }
  if (/\b(equity|capital|owner.{0,5}draw|owner.{0,5}contribut|partners?)\b/.test(n)) {
    return { type: 'equity', subtype: 'equity' };
  }
  // Income / revenue. Check "other income" before "income".
  if (/\b(other income|interest income|gain on)\b/.test(n)) {
    return { type: 'revenue', subtype: 'other_income' };
  }
  // "Fees Collected" is unambiguous income even though it is fee-worded, so
  // it is decided before the guarded rule below.
  if (/\bfees? collected\b/.test(n)) {
    return { type: 'revenue', subtype: 'income' };
  }
  // Fee- and charge-worded REVENUE accounts: "Late Fee Income" (standard on
  // every property-management chart), "Finance Charge Income" (QBD's own
  // stock finance-charge account is type INC), "Delivery Fee Revenue",
  // "Membership Fees Income". The guard on the income rule below exists to
  // keep "Consulting Fees" and "Bank Service Charges" on the cost side, but
  // it also vetoed names that say income/revenue outright -- those were
  // created as ordinary EXPENSE accounts, so a year of late fees posts as a
  // negative expense: revenue and total expenses both understated by the same
  // amount, and neither line ties to the QuickBooks P&L. Only the unambiguous
  // income/revenue tokens rescue a name (not bare "sales"/"consulting", which
  // QBD cost accounts use too), only against fee/charge wording -- anything
  // that also says expense/cost/processing/penalty stays on the cost side
  // ("Deferred Income Tax Expense", "Revenue Processing Fees") -- and never
  // for deferred/unearned balances, which are liabilities.
  if (
    /\b(income|revenue)\b/.test(n) &&
    /\b(charges?|fees?)\b/.test(n) &&
    !/\b(expenses?|cost of|processing|penalt(?:y|ies)|deferred|unearned)\b/.test(n)
  ) {
    return { type: 'revenue', subtype: 'income' };
  }
  // The remaining income keywords are words QBD's stock EXPENSE accounts use
  // too ("Cost of Sales", "Sales Tax Expense", "Consulting Fees"), so they
  // only claim the name when nothing in it is expense-worded. Bare "service"
  // used to be an alternative here and matched "Bank Service Charges" (a
  // stock QBD expense account on essentially every company file), "Telephone
  // Service", "Cleaning Service", ... -- service REVENUE accounts are
  // already caught by the income/revenue/sales/fees-collected keywords, so
  // the bare token only ever produced false positives.
  if (/\b(income|revenue|sales|consulting)\b/.test(n) && !EXPENSE_WORDED.test(n)) {
    return { type: 'revenue', subtype: 'income' };
  }
  // COGS. "Cost of Sales" / "Cost of Revenue" are as common in QBD files as
  // "Cost of Goods Sold" and must not fall through to ordinary expense --
  // that would move an entire cost column out of COGS and destroy gross
  // margin.
  if (
    /\b(cost of (?:goods|sales|revenue|services?)|cogs|materials|labor|freight in|direct cost)\b/.test(n)
  ) {
    return { type: 'expense', subtype: 'cost_of_goods_sold' };
  }
  // Other expense (interest paid, depreciation, taxes, etc.).
  if (/\b(interest expense|depreciation|amortization|tax expense|loss on|other expense)\b/.test(n)) {
    return { type: 'expense', subtype: 'other_expense' };
  }
  // Default -> ordinary expense (most "X Expense", "Office", "Rent", "Utilities" etc.).
  return { type: 'expense', subtype: 'expense' };
}

const TYPE_CODE_PREFIX_FOR_INFER: Record<AccountType, number> = TYPE_CODE_PREFIX;

/**
 * Build the missingAccounts list for a preview. Caller passes the set of
 * existing-DB account names + IIF !ACCNT names; we subtract those from the
 * names referenced by transactions, infer types, and assign suggested codes.
 */
export function buildMissingAccounts(
  preview: IifPreview,
  existingNames: ReadonlySet<string>,
): ReferencedAccount[] {
  const referenced = new Map<string, number>(); // name -> count
  for (const t of preview.transactions) {
    for (const line of t.lines) {
      const key = line.account;
      referenced.set(key, (referenced.get(key) ?? 0) + 1);
    }
  }

  // Lower-cased lookup set: we treat name comparison as case-insensitive but
  // preserve the original casing from the first occurrence.
  const knownLower = new Set<string>();
  for (const n of existingNames) knownLower.add(n.toLowerCase());
  for (const a of preview.accounts) knownLower.add(a.name.toLowerCase());

  // Counters per type so suggested codes don't collide within the import.
  const counters: Record<AccountType, number> = {
    asset: 0,
    liability: 0,
    equity: 0,
    revenue: 0,
    expense: 0,
  };
  const out: ReferencedAccount[] = [];
  const sortedNames = Array.from(referenced.keys()).sort();
  for (const name of sortedNames) {
    if (knownLower.has(name.toLowerCase())) continue;
    if (name.length > MAX_NAME_LENGTH) {
      preview.warnings.push(
        `referenced account name longer than ${MAX_NAME_LENGTH} chars; cannot auto-create: "${name.slice(0, 60)}…"`,
      );
      continue;
    }
    const inferred = inferAccountType(name);
    counters[inferred.type]++;
    const code = String(TYPE_CODE_PREFIX_FOR_INFER[inferred.type] + counters[inferred.type] * 10 + 5);
    out.push({
      name,
      suggestedType: inferred.type,
      suggestedSubtype: inferred.subtype,
      suggestedCode: code,
      occurrences: referenced.get(name) ?? 0,
    });
  }
  return out;
}

/**
 * Preview-time disclosure for the standard two-file migration (lists IIF
 * first, then the transactions IIF). Accounts that already exist in the
 * chart but are INACTIVE -- typically created from the lists file's
 * HIDDEN=Y rows -- fail every transaction that references them at commit
 * ("account X is inactive"), yet they never show in missingAccounts (they
 * exist) and the in-file HIDDEN warning in parseIif only covers accounts
 * defined in THIS file's !ACCNT section. The preview route calls this with
 * the DB's inactive account names so the user can plan (re-activate,
 * import, de-activate again) instead of discovering hundreds of per-row
 * errors on the completion screen.
 */
export function warnInactiveAccountRefs(
  preview: IifPreview,
  inactiveExistingNames: ReadonlySet<string>,
): void {
  if (inactiveExistingNames.size === 0 || preview.transactions.length === 0) return;
  // Names this file itself re-defines as HIDDEN=Y already got the in-file
  // warning -- don't say the same thing twice.
  const coveredInFile = new Set(
    preview.accounts.filter((a) => !a.isActive).map((a) => a.name.toLowerCase()),
  );
  const inactiveLower = new Set<string>();
  for (const n of inactiveExistingNames) {
    const key = n.toLowerCase();
    if (!coveredInFile.has(key)) inactiveLower.add(key);
  }
  if (inactiveLower.size === 0) return;
  const affectedNames = new Map<string, string>(); // lower-cased -> file casing
  let affected = 0;
  for (const t of preview.transactions) {
    let hit = false;
    for (const l of t.lines) {
      const key = l.account.toLowerCase();
      if (inactiveLower.has(key)) {
        hit = true;
        if (!affectedNames.has(key)) affectedNames.set(key, l.account);
      }
    }
    if (hit) affected++;
  }
  if (affected === 0) return;
  const names = Array.from(affectedNames.values());
  const shown = names.slice(0, 5).map((n) => `"${n}"`).join(', ');
  const more = names.length > 5 ? ` and ${names.length - 5} more` : '';
  preview.warnings.push(
    `${affected} transaction(s) reference account(s) that exist in your chart but are ` +
      `inactive (${shown}${more}) and will be skipped at import. To post that history: ` +
      `re-activate the account(s), re-import this file (already-posted transactions are ` +
      `skipped as duplicates), then de-activate them again.`,
  );
}

/**
 * TRNS-row outcome for an unusable header row (invalid DATE, missing ACCNT,
 * invalid AMOUNT, missing TRNSTYPE). Carries what parseIif needs to track
 * the whole block structurally -- see the excludedTransactions contract on
 * IifPreview: without it these blocks appeared only as free-text warnings
 * and left no post-commit trace at all.
 */
interface TrnsRowFailure {
  failed: true;
  qbType: string;
  posts: boolean;
  reason: string;
}

function parseTrnsRow(
  cells: string[],
  cols: Record<string, number>,
  rowNo: number,
  warnings: string[],
  dateStats: {
    dayFirstDates: number;
    monthFirstDates: number;
    ambiguousDates: number;
    example: string;
  },
  dayFirst: boolean,
): ParsedTransaction | TrnsRowFailure {
  const cell = (col: string) => (cells[cols[col] ?? -1] ?? '').trim();
  const qbType = cell('TRNSTYPE');
  if (!qbType) {
    warnings.push(`row ${rowNo}: TRNS row missing TRNSTYPE; skipping`);
    return { failed: true, qbType: 'UNKNOWN', posts: true, reason: 'TRNS row missing TRNSTYPE' };
  }
  const failed = (reason: string): TrnsRowFailure => ({
    failed: true,
    qbType: qbType.toUpperCase(),
    posts: lookupTrnsType(qbType).posts,
    reason,
  });
  const dateRaw = cell('DATE');
  const date = normaliseDate(dateRaw, dayFirst);
  // Date-order evidence, gathered only in the default month-first pass. A
  // rejected date whose first component is a plausible day (13-31) and
  // second a plausible month (1-12) points at a D/M/Y-locale export; a
  // parsed date with day 13-31 proves M/D/Y; a parsed date with both
  // components <= 12 is ambiguous. parseIif re-parses or warns at file
  // level based on these counts.
  if (!dayFirst) {
    const parts = dateRaw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (parts) {
      const first = +parts[1]!;
      const second = +parts[2]!;
      if (!date && first > 12 && first <= 31 && second >= 1 && second <= 12) {
        // Only count D/M/Y-locale evidence when the transposed reading is a
        // REAL calendar date (two-digit years expand exactly as normaliseDate
        // does). "31/02/2026" is invalid in BOTH orders -- plain corruption,
        // not locale evidence -- yet it used to increment this counter and,
        // with every other date ambiguous (day <= 12), flip the entire file
        // to day/month/year, silently transposing every date in the import.
        let year = +parts[3]!;
        if (parts[3]!.length === 2) year = year < 50 ? 2000 + year : 1900 + year;
        if (isRealCalendarDate(year, second, first)) {
          dateStats.dayFirstDates++;
          if (!dateStats.example) dateStats.example = dateRaw.trim();
        }
      } else if (date && second > 12) {
        dateStats.monthFirstDates++;
      } else if (date && first <= 12 && second <= 12) {
        dateStats.ambiguousDates++;
      }
    }
  }
  if (!date) {
    warnings.push(`row ${rowNo}: invalid TRNS date "${dateRaw}"; skipping block`);
    return failed(`invalid TRNS date "${dateRaw}"`);
  }
  const account = cell('ACCNT');
  if (!account) {
    warnings.push(`row ${rowNo}: TRNS row missing ACCNT; skipping block`);
    return failed('TRNS row missing ACCNT');
  }
  const amountRaw = cell('AMOUNT');
  const amount = normaliseAmount(amountRaw);
  if (amount == null) {
    warnings.push(`row ${rowNo}: invalid TRNS amount "${amountRaw}"; skipping block`);
    return failed(`invalid TRNS amount "${amountRaw}"`);
  }
  const docNum = cell('DOCNUM') ? cell('DOCNUM').slice(0, 120) : undefined;
  const memo = truncateMemo(cell('MEMO'), rowNo, warnings);
  const name = cell('NAME') || undefined;
  const classRef = cell('CLASS') || undefined;
  const mapped = lookupTrnsType(qbType);

  return {
    rowNumber: rowNo,
    qbType: qbType.toUpperCase(),
    sourceType: mapped.sourceType,
    posts: mapped.posts,
    date,
    docNum,
    memo,
    reference: docNum,
    lines: [
      {
        account,
        amount,
        name,
        memo,
        classRef,
      },
    ],
  };
}

function parseSplRow(
  cells: string[],
  cols: Record<string, number>,
  rowNo: number,
  warnings: string[],
): ParsedSplit | null {
  const cell = (col: string) => (cells[cols[col] ?? -1] ?? '').trim();
  const account = cell('ACCNT');
  if (!account) {
    warnings.push(`row ${rowNo}: SPL row missing ACCNT; skipping`);
    return null;
  }
  const amountRaw = cell('AMOUNT');
  const amount = normaliseAmount(amountRaw);
  if (amount == null) {
    warnings.push(`row ${rowNo}: invalid SPL amount "${amountRaw}"; skipping`);
    return null;
  }
  const memo = truncateMemo(cell('MEMO'), rowNo, warnings);
  const name = cell('NAME') || undefined;
  const classRef = cell('CLASS') || undefined;
  return { account, amount, name, memo, classRef };
}

function parseAccountRow(
  cells: string[],
  cols: Record<string, number>,
  rowNo: number,
  warnings: string[],
  obStats: { withOpeningBalance: number },
): ParsedAccount | null {
  const cell = (col: string) => (cells[cols[col] ?? -1] ?? '').trim();
  const name = cell('NAME');
  if (!name) {
    warnings.push(`row ${rowNo}: ACCNT row missing NAME; skipping`);
    return null;
  }
  if (name.length > MAX_NAME_LENGTH) {
    warnings.push(
      `row ${rowNo}: account name longer than ${MAX_NAME_LENGTH} chars; skipping row`,
    );
    return null;
  }
  // Uppercase before the map lookup: real QBD exports emit uppercase
  // keywords, but hand-edited and conversion-tool files carry "Bank"/"bank",
  // and a raw-cased lookup silently reclassified balance-sheet accounts as
  // expenses. Matches the TRNSTYPE path, which uppercases before its lookup.
  const rawType = cell('ACCNTTYPE');
  if (!rawType) {
    // A blank/absent ACCNTTYPE (truncated row, or a converted file whose
    // header lacks the column) used to take the EXP default silently -- a
    // balance-sheet account created as an expense with nothing flagging it
    // beyond a type column the user would have to notice. Disclose it the
    // same way the unknown-type branch below does.
    warnings.push(
      `row ${rowNo}: ACCNT row for "${name}" has no ACCNTTYPE -- treating as expense`,
    );
  }
  const qbType = (rawType || 'EXP').toUpperCase();
  // Non-posting accounts (Estimates, Purchase Orders, ...) never hit the
  // ledger -- skip them entirely, matching how non-posting TRNS blocks are
  // handled, instead of creating junk expense accounts.
  if (qbType === 'NONPOSTING') {
    warnings.push(
      `row ${rowNo}: non-posting account "${name}" skipped (does not post to the ledger)`,
    );
    return null;
  }
  const mapped = ACCNT_TYPE_MAP[qbType];
  if (!mapped) {
    warnings.push(
      `row ${rowNo}: unknown ACCNTTYPE "${qbType}" for "${name}" -- treating as expense`,
    );
  }
  const desc = cell('DESC');
  const final = mapped ?? { type: 'expense' as const, subtype: 'expense' as const };
  // QBD emits plain EQUITY for Retained Earnings -- IIF has no distinct code
  // for it -- but the subtype is load-bearing downstream: the statement of
  // cash flows skips retained_earnings (already counted via net income) while
  // plain `equity` lands in financing. The transactions-only path infers
  // retained_earnings from the name, so without this the SAME account gets a
  // different subtype depending on which file the customer imported first,
  // and PATCH /ledger/accounts refuses type/subtype edits after the fact.
  // Only the subtype is narrowed; the type stays equity either way.
  const subtype =
    final.type === 'equity' && inferAccountType(name).subtype === 'retained_earnings'
      ? ('retained_earnings' as const)
      : final.subtype;
  // OBAMOUNT (the account's QBD opening balance) is read but deliberately NOT
  // imported: QuickBooks materialises opening balances as real transactions
  // against Opening Balance Equity, and those arrive with the transactions
  // export -- posting the column here as well would double-book every one.
  // Counting the non-zero ones lets parseIif disclose that a lists-only
  // import leaves the balances behind, instead of leaving the only
  // money-bearing column in the file completely unmentioned.
  const rawOb = cell('OBAMOUNT');
  if (rawOb) {
    const ob = normaliseAmount(rawOb);
    if (ob !== null && !/^-?0+\.0+$/.test(ob)) obStats.withOpeningBalance++;
  }
  // Real QBD lists exports carry the customer's own numbering in ACCNUM.
  // Preserve it -- CPAs cross-reference old QBD reports and workpapers by
  // these numbers. Accounts without one get a synthetic code in the
  // post-pass. Cap at 40 chars to match the commit schema.
  const accnum = cell('ACCNUM').slice(0, 40);
  return {
    name,
    qbType,
    type: final.type,
    subtype,
    description: desc ? desc.slice(0, 500) : undefined,
    suggestedCode: accnum, // synthetic code assigned later when empty
    // QBD marks records made inactive with HIDDEN=Y. A 15-year company file
    // routinely carries hundreds of retired accounts; arriving active they
    // flood every picker and accept new postings to accounts the CPA
    // deliberately closed.
    isActive: cell('HIDDEN').toUpperCase() !== 'Y',
  };
}

/**
 * QBD address blocks are five free-text lines (BADDR1-5 / SADDR1-5): the
 * first line is usually the payee/customer name, the middle lines the
 * street, and the last a "City, ST 12345" line. Best-effort structure into
 * the { street1, street2, city, state, postalCode } jsonb shape the rest of
 * KPBooks uses (1099 recipient addresses, statements, invoices). Anything
 * that doesn't match stays in the street lines so no data is dropped.
 */
function parseAddressLines(
  rawLines: string[],
  dropNames: (string | undefined)[],
): ParsedAddress | undefined {
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
  const drop = new Set(
    dropNames.filter((n): n is string => Boolean(n)).map((n) => n.toLowerCase()),
  );
  while (lines.length > 0 && drop.has(lines[0]!.toLowerCase())) lines.shift();
  if (lines.length === 0) return undefined;
  const out: ParsedAddress = {};
  const last = lines[lines.length - 1]!;
  const cityLine = last.match(/^(.+?),?\s+([A-Za-z]{2})\.?,?\s+(\d{5}(?:-\d{4})?)$/);
  if (cityLine) {
    lines.pop();
    out.city = cityLine[1]!.replace(/,$/, '').slice(0, 100);
    out.state = cityLine[2]!.toUpperCase();
    out.postalCode = cityLine[3]!;
  }
  if (lines.length > 0) out.street1 = lines[0]!.slice(0, 200);
  if (lines.length > 1) out.street2 = lines.slice(1).join(', ').slice(0, 200);
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseCustomerRow(
  cells: string[],
  cols: Record<string, number>,
  rowNo: number,
  warnings: string[],
): ParsedCustomer | null {
  const cell = (col: string) => (cells[cols[col] ?? -1] ?? '').trim();
  const name = cell('NAME');
  if (!name) {
    warnings.push(`row ${rowNo}: CUST row missing NAME; skipping`);
    return null;
  }
  if (name.length > MAX_NAME_LENGTH) {
    warnings.push(`row ${rowNo}: customer name longer than ${MAX_NAME_LENGTH} chars; skipping row`);
    return null;
  }
  // Real QBD !CUST exports carry the company in COMPANYNAME. PRINTAS is a
  // vendor/employee "Print on Check as" field -- kept only as a fallback for
  // files that happen to have it.
  const company = cell('COMPANYNAME') || cell('PRINTAS');
  const note = cell('NOTE');
  const phone = cell('PHONE1');
  const email = sanitiseEmail(cell('EMAIL'), rowNo, `customer "${name}"`, warnings);
  const terms = cell('TERMS');
  const termsDays = parseTermsToDays(terms, rowNo, `customer "${name}"`, warnings);
  // Real QBD !CUST exports carry the billing address in BADDR1-5 and the
  // shipping address in SADDR1-5.
  const billingAddress = parseAddressLines(
    ['BADDR1', 'BADDR2', 'BADDR3', 'BADDR4', 'BADDR5'].map((c) => cell(c)),
    [name, company],
  );
  const shippingAddress = parseAddressLines(
    ['SADDR1', 'SADDR2', 'SADDR3', 'SADDR4', 'SADDR5'].map((c) => cell(c)),
    [name, company],
  );
  return {
    displayName: name,
    companyName: company && company !== name ? company.slice(0, 255) : undefined,
    email,
    phone: truncateContactField(phone, rowNo, `customer "${name}"`, 'phone', warnings),
    notes: note ? note.slice(0, 2000) : undefined,
    defaultTermsDays: termsDays,
    billingAddress,
    shippingAddress,
    isActive: cell('HIDDEN').toUpperCase() !== 'Y',
  };
}

function parseVendorRow(
  cells: string[],
  cols: Record<string, number>,
  rowNo: number,
  warnings: string[],
): ParsedVendor | null {
  const cell = (col: string) => (cells[cols[col] ?? -1] ?? '').trim();
  const name = cell('NAME');
  if (!name) {
    warnings.push(`row ${rowNo}: VEND row missing NAME; skipping`);
    return null;
  }
  if (name.length > MAX_NAME_LENGTH) {
    warnings.push(`row ${rowNo}: vendor name longer than ${MAX_NAME_LENGTH} chars; skipping row`);
    return null;
  }
  // Prefer COMPANYNAME (the actual company field); PRINTAS ("Print on Check
  // as") is the historical fallback.
  const company = cell('COMPANYNAME') || cell('PRINTAS');
  const note = cell('NOTE');
  const phone = cell('PHONE1');
  const email = sanitiseEmail(cell('EMAIL'), rowNo, `vendor "${name}"`, warnings);
  const terms = cell('TERMS');
  const taxId = cell('TAXID');
  // Real QBD VEND headers name the 1099-eligibility column "1099";
  // "VENDOR1099" is kept as a fallback for hand-built files.
  const eligible = (cell('1099') || cell('VENDOR1099')).toUpperCase() === 'Y';
  // Real QBD !VEND exports carry the mailing address in ADDR1-5 (BADDR/SADDR
  // belong to the !CUST section) -- the same address the January 1099-NEC
  // run needs for every 1099-flagged vendor. BADDR1-5 is kept as a fallback
  // for hand-built files.
  const mailingAddress =
    parseAddressLines(
      ['ADDR1', 'ADDR2', 'ADDR3', 'ADDR4', 'ADDR5'].map((c) => cell(c)),
      [name, company],
    ) ??
    parseAddressLines(
      ['BADDR1', 'BADDR2', 'BADDR3', 'BADDR4', 'BADDR5'].map((c) => cell(c)),
      [name, company],
    );
  return {
    displayName: name,
    companyName: company && company !== name ? company.slice(0, 255) : undefined,
    email,
    phone: truncateContactField(phone, rowNo, `vendor "${name}"`, 'phone', warnings),
    notes: note ? note.slice(0, 2000) : undefined,
    defaultTermsDays: parseTermsToDays(terms, rowNo, `vendor "${name}"`, warnings),
    is1099Vendor: eligible,
    taxId: truncateContactField(taxId, rowNo, `vendor "${name}"`, 'tax ID', warnings),
    mailingAddress,
    isActive: cell('HIDDEN').toUpperCase() !== 'Y',
  };
}

function parseTermsToDays(
  terms: string,
  rowNo: number,
  label: string,
  warnings: string[],
): number | undefined {
  if (!terms) return undefined;
  // Common QB strings: "Net 30", "Net 15", "Due on receipt", "1% 10 Net 30".
  const m = terms.match(/Net\s*(\d+)/i);
  if (m && m[1]) {
    const days = parseInt(m[1], 10);
    // The commit schema caps defaultTermsDays at 365. QBD terms are
    // user-defined free text ("Net 400" is legal there), and an over-cap
    // value that sailed through preview would 400 the ENTIRE commit with a
    // ZodError. Degrade to no-default-terms with a warning instead
    // (mirrors sanitiseEmail).
    if (days > 365) {
      warnings.push(
        `row ${rowNo}: ${label} terms "${terms}" exceed Net 365; importing without default terms`,
      );
      return undefined;
    }
    return days;
  }
  if (/due\s*on\s*receipt/i.test(terms)) return 0;
  return undefined;
}

// ------------------------- Commit -------------------------------------------

const CommitAccount = z.object({
  // QBD sub-account colon paths run to ~159 chars (31/level, 5 levels); 255
  // gives headroom. The parser skips anything longer, so one corrupt row can
  // never 400 the whole commit.
  name: z.string().min(1).max(255),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  subtype: z.enum([
    'bank',
    'accounts_receivable',
    'other_current_asset',
    'fixed_asset',
    'other_asset',
    'accounts_payable',
    'credit_card',
    'other_current_liability',
    'long_term_liability',
    'equity',
    'retained_earnings',
    'income',
    'other_income',
    'expense',
    'cost_of_goods_sold',
    'other_expense',
  ]),
  code: z.string().min(1).max(40),
  description: z.string().max(500).optional(),
  /** False for QBD HIDDEN=Y rows (inactive in QBD). */
  isActive: z.boolean().default(true),
});

/**
 * QB's e-mail field is free text, so an unparseable value must degrade to
 * "no email" instead of throwing a ZodError that 400s the entire commit
 * (the parser already keeps the first valid address at preview time; the
 * .catch is the backstop for anything that slips through).
 */
const TolerantEmail = z.string().email().max(200).optional().catch(undefined);

/**
 * Address shape shared with the customers/vendors CRUD routes. The .catch
 * backstop degrades a malformed address to "no address" rather than letting
 * one row 400 the whole commit (same policy as TolerantEmail).
 */
const TolerantAddress = z
  .object({
    street1: z.string().max(200).optional(),
    street2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(60).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().max(60).optional(),
  })
  .optional()
  .catch(undefined);

const CommitCustomer = z.object({
  // Customer:job colon paths run to ~209 chars (41/level, 5 levels).
  displayName: z.string().min(1).max(255),
  companyName: z.string().max(255).optional(),
  email: TolerantEmail,
  phone: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
  defaultTermsDays: z.number().int().min(0).max(365).optional(),
  billingAddress: TolerantAddress,
  shippingAddress: TolerantAddress,
  isActive: z.boolean().default(true),
});

const CommitVendor = z.object({
  displayName: z.string().min(1).max(255),
  companyName: z.string().max(255).optional(),
  email: TolerantEmail,
  phone: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
  defaultTermsDays: z.number().int().min(0).max(365).optional(),
  is1099Vendor: z.boolean().default(false),
  taxId: z.string().max(40).optional(),
  mailingAddress: TolerantAddress,
  isActive: z.boolean().default(true),
});

export const CommitIifSchema = z.object({
  accounts: z.array(CommitAccount).default([]),
  customers: z.array(CommitCustomer).default([]),
  vendors: z.array(CommitVendor).default([]),
});

export type CommitIifInput = z.infer<typeof CommitIifSchema>;

export interface CommitResult {
  accountsCreated: number;
  accountsSkipped: number;
  customersCreated: number;
  customersSkipped: number;
  vendorsCreated: number;
  vendorsSkipped: number;
  conflicts: { kind: 'account' | 'customer' | 'vendor'; identifier: string; reason: string }[];
  /** Rows that imported but need attention (renumbered codes, missing 1099 TINs). */
  warnings: string[];
}

export interface CommitContext {
  companyId: string;
  userId: string;
}

/**
 * Smallest not-taken account code: numeric codes count up (1010 -> 1011);
 * anything else gets a numeric suffix. BigInt because codes run to 40 chars.
 */
function nextFreeCode(requested: string, taken: ReadonlySet<string>): string {
  if (/^\d+$/.test(requested)) {
    let n = BigInt(requested);
    for (;;) {
      n += 1n;
      const candidate = String(n).padStart(requested.length, '0');
      if (!taken.has(candidate)) return candidate;
    }
  }
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = requested.slice(0, 40 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * What a skipped vendor row carries that the stored vendor does not.
 *
 * Create-on-conflict stays the policy (auto-updating would clobber edits made
 * inside KPBooks), but silently dropping data the CPA just corrected in
 * QuickBooks and re-exported is not acceptable on the documented
 * fix-and-re-import path: `is_1099_vendor` is what the January 1099-NEC run
 * filters on, so a false->true correction dropped here removes the vendor
 * from the run entirely, at any dollar amount, with nothing anywhere saying
 * so. Tax IDs are described, never echoed -- they are SSNs/EINs.
 */
function vendorFieldDisagreements(
  file: CommitIifInput['vendors'][number],
  stored: { is1099Vendor: boolean | null; taxId: string | null; mailingAddress: unknown },
): string[] {
  const diffs: string[] = [];
  if (file.is1099Vendor && !stored.is1099Vendor) {
    diffs.push('this file flags it as a 1099 vendor but the existing vendor is not flagged');
  }
  if (file.taxId) {
    if (!stored.taxId) diffs.push('this file has a tax ID but the existing vendor has none');
    else if (file.taxId !== stored.taxId) diffs.push('this file has a different tax ID');
  }
  if (file.mailingAddress && !stored.mailingAddress) {
    diffs.push('this file has a mailing address but the existing vendor has none');
  }
  return diffs;
}

/** Customer-side twin of vendorFieldDisagreements (statements and invoices
 * read the stored customer, so the same silent-drop hazard applies). */
function customerFieldDisagreements(
  file: CommitIifInput['customers'][number],
  stored: {
    email: string | null;
    phone: string | null;
    defaultTermsDays: number | null;
    billingAddress: unknown;
  },
): string[] {
  const diffs: string[] = [];
  if (file.email) {
    if (!stored.email) diffs.push('this file has an email but the existing customer has none');
    else if (file.email.toLowerCase() !== stored.email.toLowerCase()) {
      diffs.push(`this file has a different email (${file.email})`);
    }
  }
  if (file.phone && !stored.phone) {
    diffs.push('this file has a phone number but the existing customer has none');
  }
  if (file.defaultTermsDays != null && stored.defaultTermsDays == null) {
    diffs.push(
      `this file has payment terms (net ${file.defaultTermsDays}) but the existing customer has none`,
    );
  }
  if (file.billingAddress && !stored.billingAddress) {
    diffs.push('this file has a billing address but the existing customer has none');
  }
  return diffs;
}

/**
 * Skip-on-conflict policy: if a NAME already exists in the company, the row
 * is skipped -- names are the identity, so a second run with the same file
 * is a no-op. An account whose name is new but whose code is taken (every
 * company is seeded with a default chart using 1010/1100/...) is NOT
 * skipped: it gets the next free code, because dropping it would strand
 * every transaction that references it. The caller sees skip counts, a
 * conflict list, and warnings for renumbered rows.
 */
export async function commitIifImport(
  tx: Database,
  ctx: CommitContext,
  input: CommitIifInput,
): Promise<CommitResult> {
  const result: CommitResult = {
    accountsCreated: 0,
    accountsSkipped: 0,
    customersCreated: 0,
    customersSkipped: 0,
    vendorsCreated: 0,
    vendorsSkipped: 0,
    conflicts: [],
    warnings: [],
  };

  // Serialise concurrent imports for this company: conflict detection below
  // is read-then-write, so two overlapping commits would each see the
  // pre-commit snapshot and both insert. The xact-scoped advisory lock makes
  // the second request wait until the first commits.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('kpbooks.iif_import'), hashtext(${ctx.companyId}))`,
  );

  // Account conflict detection: by code (unique within company) and by name.
  // Names are compared case-insensitively to match buildMissingAccounts and
  // commitIifTransactions (QBD casing routinely differs from what the user
  // typed into KPBooks), so we fetch the whole chart rather than inArray on
  // exact strings. Just-inserted rows are added to the sets so a duplicated
  // list row within one file can't create a duplicate record.
  if (input.accounts.length > 0) {
    const existing = await tx
      .select({
        id: accountsTable.id,
        code: accountsTable.code,
        name: accountsTable.name,
        type: accountsTable.type,
        subtype: accountsTable.subtype,
        parentId: accountsTable.parentId,
      })
      .from(accountsTable)
      .where(eq(accountsTable.companyId, ctx.companyId));
    const existingByCode = new Set(existing.map((r) => r.code));
    const existingByName = new Set(existing.map((r) => r.name.toLowerCase()));
    const existingRowByName = new Map(existing.map((r) => [r.name.toLowerCase(), r]));
    // lower-cased name -> id of accounts created by THIS run, for the
    // sub-account parent linking pass below.
    const createdIdByName = new Map<string, string>();

    for (const a of input.accounts) {
      if (existingByName.has(a.name.toLowerCase())) {
        result.accountsSkipped++;
        result.conflicts.push({
          kind: 'account',
          identifier: a.name,
          reason: 'name already exists',
        });
        // The skip keeps the EXISTING account (names are identity), but if
        // the file disagrees about its type, the chart may be carrying a
        // heuristic guess from an earlier transactions-first import. Say so
        // -- otherwise the wrong classification survives every re-import of
        // the lists file with only "already exists" noise as a trace, and
        // the migrated balance sheet never matches QBD with no clue why.
        const stored = existingRowByName.get(a.name.toLowerCase());
        if (
          stored?.type &&
          stored.subtype &&
          (stored.type !== a.type || stored.subtype !== a.subtype)
        ) {
          result.warnings.push(
            `account "${a.name}": this file says ${a.type}/${a.subtype} but the existing ` +
              `account is ${stored.type}/${stored.subtype} -- the existing type was kept. ` +
              `An account's type cannot be changed once it exists (posted journal lines depend ` +
              `on it), so if the file is right, create a new ${a.type}/${a.subtype} account, ` +
              `move the balance to it with a journal entry, and deactivate this one`,
          );
        }
        continue;
      }
      let code = a.code;
      if (existingByCode.has(code)) {
        // The name is new, so this is a numbering clash (the seeded default
        // chart already uses 1010/1100/...), not a re-import. Renumber to
        // the next free code instead of dropping the account -- a skipped
        // account fails every transaction that references it by name.
        code = nextFreeCode(code, existingByCode);
        result.warnings.push(
          `account "${a.name}": code ${a.code} already exists; assigned ${code} instead`,
        );
      }
      const [created] = await tx
        .insert(accountsTable)
        .values({
          companyId: ctx.companyId,
          code,
          name: a.name,
          type: a.type,
          subtype: a.subtype as never,
          currency: 'USD',
          description: a.description ?? null,
          // HIDDEN=Y in QBD -> inactive here, so retired accounts don't
          // flood pickers or accept new postings.
          isActive: a.isActive,
        })
        .returning({ id: accountsTable.id });
      if (created) createdIdByName.set(a.name.toLowerCase(), created.id);
      existingByCode.add(code);
      existingByName.add(a.name.toLowerCase());
      result.accountsCreated++;
    }

    // QBD sub-accounts arrive as colon paths ("Utilities:Gas & Electric").
    // The full path stays as the NAME (transactions resolve accounts by full
    // path), but parent_id must be linked too or every balance-sheet / P&L
    // rollup by parent account is lost after migration. Runs after the
    // insert loop so a parent defined later in the same file still resolves.
    for (const a of input.accounts) {
      // A row skipped as "name already exists" still needs its parent link:
      // on a transactions-first migration the sub-account was auto-created
      // from missingAccounts with parent_id NULL (its parent had no direct
      // postings, so nothing referenced it), and the lists file that finally
      // names the parent skips the child -- leaving the chart permanently
      // flat with only "already exists" noise as a trace. Fall back to the
      // stored row, but only while its parent_id is still NULL, so a link an
      // earlier import (or the user) already established is never re-pointed.
      const stored = existingRowByName.get(a.name.toLowerCase());
      const childId =
        createdIdByName.get(a.name.toLowerCase()) ??
        (stored && stored.parentId === null ? stored.id : undefined);
      if (!childId) continue;
      const colon = a.name.lastIndexOf(':');
      if (colon <= 0) continue;
      const parentName = a.name.slice(0, colon).trim();
      const parentId =
        createdIdByName.get(parentName.toLowerCase()) ??
        existingRowByName.get(parentName.toLowerCase())?.id;
      if (!parentId) {
        result.warnings.push(
          `account "${a.name}": parent "${parentName}" not found -- imported without a hierarchy link`,
        );
        continue;
      }
      await tx.update(accountsTable).set({ parentId }).where(eq(accountsTable.id, childId));
    }
  }

  if (input.customers.length > 0) {
    // Select the fields the file also carries, not just the name: a skipped
    // row still has to disclose what THIS file says that the stored customer
    // doesn't (same reasoning as the account disagreement warning above --
    // on a lists re-import every row conflicts, so "already exists" alone is
    // uniform noise that hides real corrections).
    const existingRows = await tx
      .select({
        name: customersTable.displayName,
        email: customersTable.email,
        phone: customersTable.phone,
        defaultTermsDays: customersTable.defaultTermsDays,
        billingAddress: customersTable.billingAddress,
      })
      .from(customersTable)
      .where(eq(customersTable.companyId, ctx.companyId));
    const existing = new Set(existingRows.map((r) => r.name.toLowerCase()));
    const existingRowByName = new Map(existingRows.map((r) => [r.name.toLowerCase(), r]));
    for (const c of input.customers) {
      if (existing.has(c.displayName.toLowerCase())) {
        result.customersSkipped++;
        result.conflicts.push({
          kind: 'customer',
          identifier: c.displayName,
          reason: 'name already exists',
        });
        const stored = existingRowByName.get(c.displayName.toLowerCase());
        const diffs = stored ? customerFieldDisagreements(c, stored) : [];
        if (diffs.length > 0) {
          result.warnings.push(
            `customer "${c.displayName}": already exists, so the row was skipped -- ` +
              `${diffs.join('; ')}. The existing customer was kept; edit it if the file is right.`,
          );
        }
        continue;
      }
      await tx.insert(customersTable).values({
        companyId: ctx.companyId,
        displayName: c.displayName,
        companyName: c.companyName ?? null,
        email: c.email ?? null,
        phone: c.phone ?? null,
        notes: c.notes ?? null,
        defaultTermsDays: c.defaultTermsDays ?? null,
        billingAddress: c.billingAddress ?? null,
        shippingAddress: c.shippingAddress ?? null,
        isActive: c.isActive,
      });
      existing.add(c.displayName.toLowerCase());
      result.customersCreated++;
    }

    // QBD customer:job colon paths import as independent customers -- the
    // customers table has no parent/job column yet, so the hierarchy cannot
    // be represented. Say so instead of letting the user assume job-costing
    // rollups came over.
    const jobPaths = input.customers.filter((c) => c.displayName.includes(':')).length;
    if (jobPaths > 0) {
      result.warnings.push(
        `${jobPaths} customer name(s) contain ":" (QBD customer:job paths) -- jobs import as ` +
          `separate top-level customers; job-under-customer hierarchy is not preserved yet`,
      );
    }
  }

  if (input.vendors.length > 0) {
    // Same widened pre-scan as the customers branch: the 1099 flag is the
    // sharp edge here. The January 1099-NEC run filters on is_1099_vendor, so
    // a W-9 correction re-imported from QBD that lands on an existing vendor
    // is dropped with no trace and the vendor silently misses their 1099.
    const existingRows = await tx
      .select({
        name: vendorsTable.displayName,
        is1099Vendor: vendorsTable.is1099Vendor,
        taxId: vendorsTable.taxId,
        mailingAddress: vendorsTable.mailingAddress,
      })
      .from(vendorsTable)
      .where(eq(vendorsTable.companyId, ctx.companyId));
    const existing = new Set(existingRows.map((r) => r.name.toLowerCase()));
    const existingRowByName = new Map(existingRows.map((r) => [r.name.toLowerCase(), r]));
    for (const v of input.vendors) {
      if (existing.has(v.displayName.toLowerCase())) {
        result.vendorsSkipped++;
        result.conflicts.push({
          kind: 'vendor',
          identifier: v.displayName,
          reason: 'name already exists',
        });
        const stored = existingRowByName.get(v.displayName.toLowerCase());
        const diffs = stored ? vendorFieldDisagreements(v, stored) : [];
        if (diffs.length > 0) {
          result.warnings.push(
            `vendor "${v.displayName}": already exists, so the row was skipped -- ` +
              `${diffs.join('; ')}. The existing vendor was kept; edit it if the file is right ` +
              `(1099 totals and forms read the stored vendor, not this file).`,
          );
        }
        continue;
      }
      // A 1099-flagged vendor without a tax ID still imports -- dropping the
      // row would lose the vendor (and the 1099 flag) entirely. The missing
      // TIN is surfaced as a warning; 1099 form generation validates it
      // again, and the W-9 request flow exists to collect it before year-end.
      if (v.is1099Vendor && !(v.taxId && v.taxId.length > 0)) {
        result.warnings.push(
          `vendor "${v.displayName}" is 1099-flagged but has no tax ID -- collect a W-9 before generating 1099s`,
        );
      }
      // Same disclosure for the mailing address: the 1099-NEC needs a
      // recipient street/city/state/ZIP just as much as the TIN.
      if (v.is1099Vendor && !v.mailingAddress) {
        result.warnings.push(
          `vendor "${v.displayName}" is 1099-flagged but has no mailing address -- 1099 forms need street, city, state, and ZIP`,
        );
      }
      await tx.insert(vendorsTable).values({
        companyId: ctx.companyId,
        displayName: v.displayName,
        companyName: v.companyName ?? null,
        email: v.email ?? null,
        phone: v.phone ?? null,
        notes: v.notes ?? null,
        defaultTermsDays: v.defaultTermsDays ?? null,
        is1099Vendor: v.is1099Vendor,
        taxId: v.taxId ?? null,
        mailingAddress: v.mailingAddress ?? null,
        isActive: v.isActive,
      });
      existing.add(v.displayName.toLowerCase());
      result.vendorsCreated++;
    }
  }

  return result;
}

// ------------------------- Transaction commit ------------------------------

const CommitSplit = z.object({
  account: z.string().min(1),
  amount: z.string().regex(/^-?\d+\.\d{4}$/),
  name: z.string().optional(),
  memo: z.string().optional(),
  classRef: z.string().optional(),
});

const CommitTransaction = z.object({
  rowNumber: z.number().int().nonnegative().default(0),
  qbType: z.string().min(1),
  sourceType: z.enum([
    'invoice',
    'bill',
    'payment',
    'bank_transaction',
    'reconciliation',
    'payroll',
    'import',
    'manual',
  ]),
  posts: z.boolean(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  docNum: z.string().max(120).optional(),
  memo: z.string().max(500).optional(),
  reference: z.string().max(120).optional(),
  lines: z.array(CommitSplit).min(2),
});

export const CommitIifTransactionsSchema = z.object({
  transactions: z.array(CommitTransaction).default([]),
});

export type CommitIifTransactionsInput = z.infer<typeof CommitIifTransactionsSchema>;

export interface TransactionCommitResult {
  posted: number;
  skipped: number;
  /** Blocks identical to an already-posted journal entry -- silently not
   * re-posted so re-importing the same file can't double-book the ledger. */
  duplicates: number;
  /** All-zero blocks (QBD exports voided checks as 0.00 lines) -- nothing to
   * post, counted separately so they don't read as failures. */
  voided: number;
  /** Posted blocks that ALSO wrote a payments-subledger row (vendor check /
   * bill payment whose TRNS NAME matched a vendor) so 1099 totals and
   * payroll registers see the imported history. Money IN from customers is
   * never linked -- see derivePaymentLink. */
  paymentsLinked: number;
  /**
   * Duplicate blocks whose earlier run posted GL-only (the payee matched no
   * vendor/customer at the time) but whose payee matches NOW: the missing
   * payments-subledger row is written against the already-posted entry.
   * Without this, the documented remediation -- create the vendor, re-import
   * the same file -- silently no-ops and 1099 totals stay short with no
   * remaining signal.
   */
  paymentsBackfilled: number;
  /**
   * Non-fatal disclosures:
   *  - a posted block whose date+reference match an existing entry with
   *    different amounts/accounts -- the signature of a transaction edited in
   *    QuickBooks after an earlier import, which the content fingerprint
   *    cannot treat as a duplicate (both versions are now on the ledger and
   *    only this warning says so);
   *  - the A/R / A/P subledger gap when the file carries invoices or bills
   *    (the GL is right, the aging reports and statements stay empty);
   *  - a duplicate block whose already-posted entry could not be given its
   *    missing payments-subledger row (the entry itself is untouched, so this
   *    is explicitly NOT an `errors` entry -- see the backfill catch).
   */
  warnings: string[];
  /**
   * Money-OUT blocks that posted to the GL but wrote NO payments row because
   * the TRNS NAME matched no vendor (payee typo variants, QBD "Other Names",
   * employees on PAYCHECKs, vendors unticked at import). 1099 totals and
   * payroll registers read the payments table, so these amounts are invisible
   * there -- aggregated per payee so the user gets an actionable list instead
   * of a silent shortfall.
   */
  unlinkedPayees: { name: string; count: number; total: string }[];
  errors: { rowNumber: number; qbType: string; reason: string }[];
}

/**
 * Content fingerprint used for idempotent transaction import. Two entries are
 * "the same transaction" when date + reference + memo + the exact multiset of
 * (account, signed amount) lines match. sourceType is deliberately excluded:
 * it is derived metadata (the TRNSTYPE map can improve between releases) and
 * must not defeat duplicate detection on re-import.
 */
function entryFingerprint(
  entryDate: string,
  reference: string | null | undefined,
  memo: string | null | undefined,
  lines: { accountId: string; signedAmount: string }[],
): string {
  const lineKey = lines
    .map((l) => `${l.accountId}:${l.signedAmount}`)
    .sort()
    .join('|');
  return createHash('sha256')
    .update(`${entryDate}\u0000${reference ?? ''}\u0000${memo ?? ''}\u0000${lineKey}`)
    .digest('hex');
}

/**
 * The same content fingerprint with the DATE deliberately left out: reference
 * + memo + the exact multiset of (account, signed amount) lines. Correcting a
 * transaction's date in QuickBooks after an earlier import changes every
 * date-bearing identity at once -- the fingerprint, the source_id stamp AND
 * the date+reference index -- so the re-import posts a second copy with
 * nothing in `warnings`. Matching on this key instead lets the commit
 * recognise "same transaction, moved to another day" and disclose it. Only
 * consulted for blocks that carry a reference, so an unnumbered recurring
 * payment can never collide with itself.
 */
function datelessFingerprint(
  reference: string | null | undefined,
  memo: string | null | undefined,
  lines: { accountId: string; signedAmount: string }[],
): string {
  return entryFingerprint('', reference, memo, lines);
}

/**
 * Identity for the same disclosure on blocks that carry NO reference: QBD
 * writes no DOCNUM for DEPOSIT, TRANSFER and most CCARD blocks, which are
 * exactly the ones a bookkeeper re-categorises. Keyed on the date plus the
 * TRNS-row (bank-side) line, which survives a re-categorisation of the other
 * leg while staying specific enough that six unrelated deposits on one day
 * don't warn about each other.
 */
function bankSideKey(entryDate: string, accountId: string, signedAmount: string): string {
  return `${entryDate}|${accountId}|${signedAmount}`;
}

/** Canonicalise a NUMERIC string to the parser's 4dp form for fingerprinting. */
function canonAmount(raw: string): string {
  return normaliseAmount(raw) ?? raw;
}

/**
 * Rename-proof provenance stamped on every imported entry (journal_entries.
 * source_id): a UUID derived from the FILE's own content -- date, reference,
 * memo, and the sorted multiset of (lower-cased account NAME as written in
 * the file, signed amount) -- rather than from resolved accountIds. The
 * accountId fingerprint above breaks when an account is renamed in KPBooks
 * between imports: the file's old name re-resolves to a freshly auto-created
 * account, every block touching it gets a different fingerprint, and the
 * whole file re-posts. This stamp survives any rename because nothing in it
 * depends on chart state; a re-imported block is tied to the file, not to
 * volatile accountIds. Formatted as a v8-style UUID so it fits the uuid
 * column; a hash can never collide with the real document ids other modules
 * store in source_id. Zero-amount lines are dropped to mirror the posted
 * lines the accountId fingerprint sees.
 */
function importSourceId(
  entryDate: string,
  reference: string | null | undefined,
  memo: string | null | undefined,
  lines: { account: string; amount: string }[],
): string {
  const lineKey = lines
    .filter((l) => !/^-?0+\.0{4}$/.test(l.amount))
    .map((l) => `${l.account.toLowerCase()}:${canonAmount(l.amount)}`)
    .sort()
    .join('|');
  const digest = createHash('sha256')
    .update(`iif\u0000${entryDate}\u0000${reference ?? ''}\u0000${memo ?? ''}\u0000${lineKey}`)
    .digest('hex');
  // First 16 bytes as a UUID: version nibble forced to 8 ("custom"), RFC
  // variant bits on the 17th hex digit.
  const variant = ((parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = `${digest.slice(0, 12)}8${digest.slice(13, 16)}${variant}${digest.slice(17, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Split a values list into batches safe for a single inArray(): each bound
 * value is one bind parameter, and postgres.js hard-rejects statements with
 * >= 65,534 parameters. 10k leaves ample headroom for the other bindings in
 * the statement.
 */
const IN_ARRAY_CHUNK_SIZE = 10_000;
function chunkForInArray<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_ARRAY_CHUNK_SIZE) {
    out.push(values.slice(i, i + IN_ARRAY_CHUNK_SIZE));
  }
  return out;
}

/**
 * Append every row of `rows` to `target`.
 *
 * Deliberately NOT `target.push(...rows)`: spread passes each element as a
 * separate function argument and V8 throws `RangeError: Maximum call stack
 * size exceeded` past ~125k of them. chunkForInArray bounds the number of
 * BIND PARAMETERS per query (10k ids), not the number of ROWS a query
 * returns -- one batch of 10k entry ids on a payroll-heavy ledger (15-30
 * splits per paycheck) comes back with 200k journal_lines. The duplicate
 * pre-scan runs before the per-block try/catch and outside any savepoint, so
 * the throw escaped commitIifTransactions as an opaque 500 that reproduced on
 * every retry of the same chunk -- exactly the fix-and-re-run path this scan
 * exists to protect.
 */
export function pushAllRows<T>(target: T[], rows: readonly T[]): void {
  for (const row of rows) target.push(row);
}

/**
 * QBD money-out TRNSTYPEs that should also write a vendor_sent payments row,
 * keyed with spaces/hyphens stripped (like TRNSTYPE_MAP_NORMALISED). 1099-NEC
 * totals, the payroll register, and workers-comp summaries read the payments
 * table -- not the GL -- so an import that stops at journal_entries silently
 * understates every one of them (a $40k year of subcontractor checks would
 * vanish from the January 1099 run).
 */
const VENDOR_SENT_TRNSTYPES: Record<string, 'check' | 'credit_card'> = {
  CHECK: 'check',
  CHK: 'check',
  BILLPMT: 'check',
  BILLPMTCHECK: 'check',
  BILLPMTCCARD: 'credit_card',
  PAYCHECK: 'check',
  LIABILITYCHECK: 'check',
  LIABCHECK: 'check',
};

/**
 * Money-in TRNSTYPEs (customer payments / sales receipts). These post to the
 * GL like any other block but deliberately DO NOT write a payments-subledger
 * row -- see the customer-payment note in derivePaymentLink. Kept as a set so
 * the A/R disclosure below can count them.
 */
const CUSTOMER_RECEIVED_TRNSTYPES = new Set(['PAYMENT', 'RCPT']);

/** Sales documents that settle on the spot (DR bank, CR income) and create no
 * A/R. They share sourceType 'invoice' with real invoices, so the A/R
 * disclosure excludes them by TRNSTYPE. */
const CASH_SALE_TRNSTYPES = new Set(['CASHSALE', 'CASHREFUND']);

interface PaymentLink {
  paymentType: 'vendor_sent' | 'customer_received';
  counterpartyId: string;
  method: 'check' | 'credit_card' | 'other';
  bankAccountId: string;
  /** Positive 4dp amount (the TRNS-line total). */
  amount: string;
}

/**
 * Decide whether a posting block should also land in the payments subledger.
 * The TRNS (first) line carries the transaction total against the bank-side
 * account and the payee NAME; a money-out type whose NAME matches a vendor
 * becomes vendor_sent. Anything else stays GL-only -- `unmatchedPayee`
 * reports the NAME when a money-out block WOULD have linked but found no
 * vendor, so the commit can disclose the gap (those amounts are otherwise
 * silently missing from 1099 totals and payroll registers).
 *
 * Money IN from a customer is deliberately NOT written here, even when the
 * NAME matches a customer. Customer statements compute the balance as
 * SUM(invoices.total) - SUM(payments.amount) (statements.service.ts), and an
 * IIF import cannot create the invoice side: QBD's transaction export does
 * not carry which invoice each payment paid, so there is nothing to build an
 * A/R document or a payment_application from. A payments row on its own turns
 * every imported customer into a phantom CREDIT balance on a customer-facing
 * statement PDF -- "we owe you $1,075" when the true balance is zero -- and
 * makes the customer a candidate in the bulk-statement run. Vendor payments
 * have no such counterpart: 1099 totals, payroll registers and pay stubs sum
 * vendor_sent payments on a cash basis and no A/P balance is computed from
 * them, so those rows stay. The A/R gap is disclosed in the commit result
 * instead of being papered over with half a subledger.
 */
function derivePaymentLink(
  t: CommitIifTransactionsInput['transactions'][number],
  trnsAccountId: string,
  vendorIdByName: ReadonlyMap<string, string>,
): { link: PaymentLink | null; unmatchedPayee: string | null } {
  const none = { link: null, unmatchedPayee: null };
  const trns = t.lines[0];
  if (!trns?.name) return none;
  const negative = trns.amount.startsWith('-');
  const positive = negative ? trns.amount.slice(1) : trns.amount;
  if (amountToMicros(positive) === 0n) return none;
  const key = t.qbType.replace(/[\s-]+/g, '');
  const counterparty = trns.name.toLowerCase();
  const vendorMethod = VENDOR_SENT_TRNSTYPES[key];
  if (vendorMethod && negative) {
    const vendorId = vendorIdByName.get(counterparty);
    if (!vendorId) return { link: null, unmatchedPayee: trns.name };
    return {
      link: {
        paymentType: 'vendor_sent',
        counterpartyId: vendorId,
        method: vendorMethod,
        bankAccountId: trnsAccountId,
        amount: positive,
      },
      unmatchedPayee: null,
    };
  }
  return none;
}

/**
 * Commit parsed IIF transactions into journal_entries via the existing
 * postEntry service. Each TRNS+SPL block becomes one journal_entry; the IIF
 * sign rule (amount > 0 -> debit, amount < 0 -> credit) is applied per line.
 *
 * Skipped reasons reported back so the user can fix and re-run:
 *   - account "X" not found in chart of accounts
 *   - block doesn't balance
 *   - closed-period block (operator must clear closed_through_date)
 *   - posting service rejected (cross-company, inactive account, etc.)
 */
export async function commitIifTransactions(
  tx: Database,
  ctx: CommitContext,
  input: CommitIifTransactionsInput,
): Promise<TransactionCommitResult> {
  const result: TransactionCommitResult = {
    posted: 0,
    skipped: 0,
    duplicates: 0,
    voided: 0,
    paymentsLinked: 0,
    paymentsBackfilled: 0,
    warnings: [],
    unlinkedPayees: [],
    errors: [],
  };
  if (input.transactions.length === 0) return result;
  // Per-payee aggregation of money-movement blocks that posted GL-only (see
  // TransactionCommitResult.unlinkedPayees). Keyed case-insensitively.
  const unlinkedByPayee = new Map<string, { name: string; count: number; totalMicros: bigint }>();
  const noteUnlinkedPayee = (payee: string, trnsAmount: string) => {
    const abs = trnsAmount.startsWith('-') ? trnsAmount.slice(1) : trnsAmount;
    const key = payee.toLowerCase();
    const agg = unlinkedByPayee.get(key) ?? { name: payee, count: 0, totalMicros: 0n };
    agg.count++;
    agg.totalMicros += amountToMicros(abs);
    unlinkedByPayee.set(key, agg);
  };
  // A/R- and A/P-document blocks that reached the ledger (posted now, or
  // already there from an earlier run). They drive the subledger disclosure
  // after the loop -- see the warnings pushed there.
  let arDocuments = 0;
  let apDocuments = 0;
  let customerPayments = 0;
  const noteSubledgerGap = (t: CommitIifTransactionsInput['transactions'][number]) => {
    const key = t.qbType.replace(/[\s-]+/g, '');
    // CASH SALE / CASH REFUND map to sourceType 'invoice' for journal
    // labelling but settle immediately and never touch A/R, so a
    // retail-only file must not be told its A/R aging is short.
    if (t.sourceType === 'invoice' && !CASH_SALE_TRNSTYPES.has(key)) arDocuments++;
    else if (t.sourceType === 'bill') apDocuments++;
    if (CUSTOMER_RECEIVED_TRNSTYPES.has(key)) customerPayments++;
  };

  // Serialise concurrent imports for this company. The fingerprint dedupe
  // below is read-then-write: two overlapping commit requests would each see
  // the pre-commit snapshot (READ COMMITTED), find zero prior fingerprints,
  // and both post every block -- doubling the whole ledger. The xact-scoped
  // advisory lock makes the second request wait until the first commits, so
  // its fingerprint scan sees the first run's entries.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('kpbooks.iif_import'), hashtext(${ctx.companyId}))`,
  );

  // Closed-period pre-check. The DB trigger enforces this too, but it is a
  // plain BEFORE INSERT trigger: letting it fire mid-import aborts the outer
  // Postgres transaction, every later statement fails with 25P02, and the
  // driver rolls the whole batch back -- an opaque 500 instead of the
  // per-row "closed period" skip this function's contract promises.
  const [companyRow] = await tx
    .select({ closedThroughDate: companiesTable.closedThroughDate })
    .from(companiesTable)
    .where(eq(companiesTable.id, ctx.companyId));
  const closedThrough = companyRow?.closedThroughDate ?? null;

  // Build a lower-cased name -> matching-accounts map for resolution. We
  // rely on RLS having scoped the tx to ctx.companyId already. The value is
  // a LIST because nothing enforces name uniqueness in the chart (only
  // company+code is unique; the CRUD routes will happily hold 'Insurance'
  // and 'INSURANCE'). Resolution prefers the exact-cased match and refuses
  // to guess between case-twins -- a single last-write-wins Map built off an
  // unordered SELECT silently routed every line to whichever twin the scan
  // returned last.
  const accountRows = await tx
    .select({ id: accountsTable.id, name: accountsTable.name, isActive: accountsTable.isActive })
    .from(accountsTable);
  const byName = new Map<string, typeof accountRows>();
  for (const a of accountRows) {
    const key = a.name.toLowerCase();
    const bucket = byName.get(key);
    if (bucket) bucket.push(a);
    else byName.set(key, [a]);
  }

  // Payee map so money-out blocks can land in the payments subledger (see
  // derivePaymentLink). The lists commit runs first, so vendors created from
  // this same file are already visible here.
  const vendorRows = await tx
    .select({ id: vendorsTable.id, name: vendorsTable.displayName })
    .from(vendorsTable);
  const vendorIdByName = new Map(vendorRows.map((v) => [v.name.toLowerCase(), v.id]));

  // Idempotency: fingerprint every journal entry already posted on the dates
  // this file touches. Re-importing the same file (the documented
  // fix-and-re-run workflow, or a double-click on Confirm after a timeout)
  // must skip already-posted blocks instead of double-booking the ledger.
  // Counts form a multiset so a file that legitimately contains N identical
  // blocks still posts N on first import and skips exactly N on re-import.
  // Impossible calendar dates (2/30 -- hand-edited files) are excluded here
  // and reported per-row in the loop below: entry_date is a Postgres `date`,
  // so one bad literal in this pre-scan query would abort the entire
  // transaction before a single block posts.
  const importDates = Array.from(
    new Set(
      input.transactions.filter((t) => t.posts && isRealIsoDate(t.date)).map((t) => t.date),
    ),
  );
  // Fingerprint -> ids of matching pre-existing entries (a multiset: N
  // identical prior copies mean N ids). Ids are kept, not just counts, so a
  // duplicate skip can backfill a missing payments-subledger link against
  // the exact entry it duplicates.
  const existingFingerprints = new Map<string, string[]>();
  // The same pre-existing entries indexed by their import-content stamp
  // (journal_entries.source_id -- see importSourceId): the rename-proof
  // duplicate path. Only entries posted by this importer carry a
  // content-derived source_id; real document ids stored there by other
  // modules can never equal a computed hash, so a hit here IS a prior
  // import of the same block. The per-entry reverse maps let an id consumed
  // via one index be removed from the other, keeping multiset semantics.
  const existingBySourceId = new Map<string, string[]>();
  const sourceIdByEntryId = new Map<string, string>();
  const fingerprintByEntryId = new Map<string, string>();
  // Pre-existing entries that already carry a payments row -- the backfill
  // below must write at most one payments row per entry.
  const entriesWithPayments = new Set<string>();
  // (date, reference) index of the same pre-existing entries, for the
  // edited-in-QBD disclosure: a block that POSTS (fingerprint differs) while
  // an entry with the same date+reference exists is the signature of a
  // transaction edited in QuickBooks after an earlier import. Duplicate
  // skips consume their own entry's key so a file with N legitimately
  // identical blocks doesn't trip the warning.
  const existingByDateRef = new Map<string, number>();
  const dateRefKeyByEntryId = new Map<string, string>();
  // Date-free content index (see datelessFingerprint) -> ids of matching
  // pre-existing entries, for the same disclosure when the QuickBooks edit
  // was to the DATE: every date-bearing identity above misses, so this is the
  // only thing left that can recognise the earlier copy.
  const existingByDatelessFp = new Map<string, string[]>();
  const datelessFpByEntryId = new Map<string, string>();
  // Bank-side line index of pre-existing entries that carry NO reference (see
  // bankSideKey), for the disclosure on DEPOSIT/TRANSFER/CCARD blocks where
  // QBD wrote no DOCNUM and the date+reference index can never fire.
  const existingByBankSide = new Map<string, string[]>();
  const bankSideKeysByEntryId = new Map<string, string[]>();
  const entryDateById = new Map<string, string>();
  // References this file carries. The date-scoped scan above cannot see an
  // earlier copy sitting on the date it was imported under BEFORE the CPA
  // corrected it, so those entries are fetched by reference as well.
  const importReferences = Array.from(
    new Set(
      input.transactions
        .filter((t) => t.posts && t.reference)
        .map((t) => t.reference as string),
    ),
  );
  if (importDates.length > 0) {
    // Both pre-scan queries are chunked: postgres.js rejects any single
    // statement with >= 65,534 bind parameters (MAX_PARAMETERS_EXCEEDED),
    // and a multi-year re-import can put more journal-entry ids on the
    // file's dates than that -- the scan also sweeps entries from OTHER
    // imports and manual work sharing those dates. One unchunked inArray
    // would abort the whole commit with a driver error exactly when the
    // documented fix-and-re-run workflow needs the duplicate scan most.
    const entryRows: {
      id: string;
      entryDate: string;
      memo: string | null;
      reference: string | null;
      sourceId: string | null;
    }[] = [];
    for (const dates of chunkForInArray(importDates)) {
      const rows = await tx
        .select({
          id: journalEntries.id,
          entryDate: journalEntries.entryDate,
          memo: journalEntries.memo,
          reference: journalEntries.reference,
          sourceId: journalEntries.sourceId,
        })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.companyId, ctx.companyId),
            inArray(journalEntries.entryDate, dates),
          ),
        );
      pushAllRows(entryRows, rows);
    }
    // Second sweep, deliberately NOT scoped to the file's dates: an entry
    // whose date was corrected in QuickBooks sits on a day this file no
    // longer mentions. Bounded by the file's own reference list (and deduped
    // against the rows already fetched), so it stays a lookup rather than a
    // full-ledger scan.
    if (importReferences.length > 0) {
      const seenIds = new Set(entryRows.map((e) => e.id));
      for (const refs of chunkForInArray(importReferences)) {
        const rows = await tx
          .select({
            id: journalEntries.id,
            entryDate: journalEntries.entryDate,
            memo: journalEntries.memo,
            reference: journalEntries.reference,
            sourceId: journalEntries.sourceId,
          })
          .from(journalEntries)
          .where(
            and(eq(journalEntries.companyId, ctx.companyId), inArray(journalEntries.reference, refs)),
          );
        pushAllRows(
          entryRows,
          rows.filter((r) => !seenIds.has(r.id)),
        );
        for (const r of rows) seenIds.add(r.id);
      }
    }
    if (entryRows.length > 0) {
      const lineRows: {
        entryId: string;
        accountId: string;
        debit: string;
        credit: string;
      }[] = [];
      for (const entryIds of chunkForInArray(entryRows.map((e) => e.id))) {
        const rows = await tx
          .select({
            entryId: journalLines.entryId,
            accountId: journalLines.accountId,
            debit: journalLines.debit,
            credit: journalLines.credit,
          })
          .from(journalLines)
          .where(inArray(journalLines.entryId, entryIds));
        pushAllRows(lineRows, rows);
      }
      const linesByEntry = new Map<string, { accountId: string; signedAmount: string }[]>();
      for (const l of lineRows) {
        const debit = canonAmount(l.debit);
        const credit = canonAmount(l.credit);
        if (debit === '0.0000' && credit === '0.0000') continue;
        const signedAmount = debit !== '0.0000' ? debit : `-${credit}`;
        (
          linesByEntry.get(l.entryId) ?? linesByEntry.set(l.entryId, []).get(l.entryId)!
        ).push({ accountId: l.accountId, signedAmount });
      }
      for (const e of entryRows) {
        const fp = entryFingerprint(e.entryDate, e.reference, e.memo, linesByEntry.get(e.id) ?? []);
        const bucket = existingFingerprints.get(fp);
        if (bucket) bucket.push(e.id);
        else existingFingerprints.set(fp, [e.id]);
        fingerprintByEntryId.set(e.id, fp);
        if (e.sourceId) {
          const sourceBucket = existingBySourceId.get(e.sourceId);
          if (sourceBucket) sourceBucket.push(e.id);
          else existingBySourceId.set(e.sourceId, [e.id]);
          sourceIdByEntryId.set(e.id, e.sourceId);
        }
        entryDateById.set(e.id, e.entryDate);
        if (e.reference) {
          const key = `${e.entryDate} ${e.reference}`;
          existingByDateRef.set(key, (existingByDateRef.get(key) ?? 0) + 1);
          dateRefKeyByEntryId.set(e.id, key);
          const dateless = datelessFingerprint(e.reference, e.memo, linesByEntry.get(e.id) ?? []);
          const datelessBucket = existingByDatelessFp.get(dateless);
          if (datelessBucket) datelessBucket.push(e.id);
          else existingByDatelessFp.set(dateless, [e.id]);
          datelessFpByEntryId.set(e.id, dateless);
        } else {
          // Reference-less entries are indexed by every line, because which
          // line was the block's TRNS (bank) row isn't recorded on the entry
          // -- the incoming block only ever looks up its own first line.
          const keys: string[] = [];
          for (const l of linesByEntry.get(e.id) ?? []) {
            const key = bankSideKey(e.entryDate, l.accountId, l.signedAmount);
            const bucket = existingByBankSide.get(key);
            if (bucket) bucket.push(e.id);
            else existingByBankSide.set(key, [e.id]);
            keys.push(key);
          }
          bankSideKeysByEntryId.set(e.id, keys);
        }
      }
      // Which of those entries already have a payments-subledger row (the
      // backfill in the duplicate branch must never write a second one).
      for (const entryIds of chunkForInArray(entryRows.map((e) => e.id))) {
        const rows = await tx
          .select({ entryId: paymentsTable.postedJournalEntryId })
          .from(paymentsTable)
          .where(inArray(paymentsTable.postedJournalEntryId, entryIds));
        for (const r of rows) {
          if (r.entryId) entriesWithPayments.add(r.entryId);
        }
      }
    }
  }

  for (const t of input.transactions) {
    if (!t.posts) {
      result.skipped++;
      continue;
    }

    // Hand-edited files can carry impossible calendar dates ("2026-02-31")
    // that pass the YYYY-MM-DD shape check. Postgres would reject the
    // literal (22008) and poison the batch; fail just this row instead.
    if (!isRealIsoDate(t.date)) {
      result.skipped++;
      result.errors.push({
        rowNumber: t.rowNumber,
        qbType: t.qbType,
        reason: `invalid calendar date "${t.date}"`,
      });
      continue;
    }

    // Resolve every line's account before posting.
    const resolved: {
      accountId: string;
      signedAmount: string;
      memo?: string | undefined;
      dimensionJson?: Record<string, unknown> | undefined;
    }[] = [];
    let unresolved: string | null = null;
    let inactiveAccount: string | null = null;
    let ambiguousAccount: string | null = null;
    for (const line of t.lines) {
      const candidates = byName.get(line.account.toLowerCase()) ?? [];
      let acc = candidates.length === 1 ? candidates[0] : undefined;
      if (!acc && candidates.length > 1) {
        // Case-twins exist ('Insurance' vs 'INSURANCE'): the exact-cased
        // match wins; with no exact match the row is ambiguous and fails
        // per-row instead of silently posting to an arbitrary twin.
        const exact = candidates.filter((c) => c.name === line.account);
        if (exact.length === 1) {
          acc = exact[0];
        } else {
          ambiguousAccount = line.account;
          break;
        }
      }
      if (!acc) {
        unresolved = line.account;
        break;
      }
      if (!acc.isActive) {
        inactiveAccount = line.account;
        break;
      }
      // Preserve QBD class tracking and per-line customer/vendor/job names.
      // journal_lines.dimension_json is the documented home for these
      // cross-references; dropping them makes P&L-by-class and job costing
      // unrecoverable after migration.
      const dims: Record<string, unknown> = {};
      if (line.classRef) dims.class = line.classRef;
      if (line.name) dims.name = line.name;
      resolved.push({
        accountId: acc.id,
        signedAmount: line.amount,
        memo: line.memo,
        dimensionJson: Object.keys(dims).length > 0 ? dims : undefined,
      });
    }
    if (ambiguousAccount !== null) {
      result.skipped++;
      result.errors.push({
        rowNumber: t.rowNumber,
        qbType: t.qbType,
        reason:
          `account "${ambiguousAccount}" matches multiple accounts in the chart that differ ` +
          `only by letter case -- rename one and re-import`,
      });
      continue;
    }
    if (unresolved !== null) {
      result.skipped++;
      result.errors.push({
        rowNumber: t.rowNumber,
        qbType: t.qbType,
        reason: `account "${unresolved}" not found in chart of accounts`,
      });
      continue;
    }
    if (inactiveAccount !== null) {
      result.skipped++;
      result.errors.push({
        rowNumber: t.rowNumber,
        qbType: t.qbType,
        reason: `account "${inactiveAccount}" is inactive`,
      });
      continue;
    }

    // Convert IIF signed amounts -> journal_lines (positive = DR, negative = CR,
    // zero = skip). Also pre-check balance so we surface a friendly error
    // rather than letting the deferred DB trigger fire generically.
    const lines: {
      accountId: string;
      debit?: string;
      credit?: string;
      currency: string;
      fxRate: string;
      memo?: string | undefined;
      dimensionJson?: Record<string, unknown> | undefined;
    }[] = [];
    let debitMicros = 0n;
    let creditMicros = 0n;
    for (const r of resolved) {
      const isZero = /^-?0+\.0{4}$/.test(r.signedAmount);
      if (isZero) continue;
      if (r.signedAmount.startsWith('-')) {
        const positive = r.signedAmount.slice(1);
        lines.push({
          accountId: r.accountId,
          credit: positive,
          currency: 'USD',
          fxRate: '1',
          memo: r.memo,
          dimensionJson: r.dimensionJson,
        });
        creditMicros += amountToMicros(positive);
      } else {
        lines.push({
          accountId: r.accountId,
          debit: r.signedAmount,
          currency: 'USD',
          fxRate: '1',
          memo: r.memo,
          dimensionJson: r.dimensionJson,
        });
        debitMicros += amountToMicros(r.signedAmount);
      }
    }

    if (lines.length === 0) {
      // All-zero block: QBD exports voided checks as TRNS 0.00 + SPL 0.00.
      // Legitimately nothing to post -- counting it as an error would send
      // the customer hand-auditing the ledger for checks that never existed.
      result.voided++;
      continue;
    }
    if (lines.length < 2) {
      result.skipped++;
      result.errors.push({
        rowNumber: t.rowNumber,
        qbType: t.qbType,
        reason: 'fewer than 2 non-zero lines',
      });
      continue;
    }
    if (debitMicros !== creditMicros) {
      result.skipped++;
      const diff = (debitMicros - creditMicros).toString();
      result.errors.push({
        rowNumber: t.rowNumber,
        qbType: t.qbType,
        reason: `block doesn't balance: debits-credits = ${diff} (4dp micros)`,
      });
      continue;
    }

    // Duplicate guard: an identical entry already exists in the ledger --
    // this block was posted by a previous run of the same file. Skip it.
    // Two independent identities are consulted: the resolved-accountId
    // fingerprint (which also matches manually keyed history), and the
    // file-content source_id stamped at post time, which survives account
    // renames in KPBooks between imports -- without it, a renamed account's
    // old name re-resolves to a freshly auto-created twin, every block
    // touching it fingerprints differently, and the documented safe
    // re-import double-books the ledger.
    const signedLines = lines.map((l) => ({
      accountId: l.accountId,
      signedAmount: l.debit ?? `-${l.credit ?? '0.0000'}`,
    }));
    const fingerprint = entryFingerprint(t.date, t.reference, t.memo, signedLines);
    const contentSourceId = importSourceId(t.date, t.reference, t.memo, t.lines);
    // Consume one prior copy (multiset semantics: N identical blocks in the
    // file skip against exactly N prior copies). Prefer a copy that still
    // lacks a payments row so the backfill below can repair it; identical
    // copies are interchangeable otherwise.
    const pickDuplicate = (bucket: string[] | undefined): string | undefined => {
      if (!bucket || bucket.length === 0) return undefined;
      let idx = bucket.findIndex((id) => !entriesWithPayments.has(id));
      if (idx < 0) idx = bucket.length - 1;
      return bucket.splice(idx, 1)[0]!;
    };
    // An id consumed via one index must leave the other, or a later block
    // could skip twice against the same prior entry.
    const consumeFromBucket = (
      map: Map<string, string[]>,
      key: string | undefined,
      id: string,
    ) => {
      const bucket = key === undefined ? undefined : map.get(key);
      if (!bucket) return;
      const i = bucket.indexOf(id);
      if (i >= 0) bucket.splice(i, 1);
    };
    let dupEntryId = pickDuplicate(existingFingerprints.get(fingerprint));
    if (dupEntryId !== undefined) {
      consumeFromBucket(existingBySourceId, sourceIdByEntryId.get(dupEntryId), dupEntryId);
    } else {
      dupEntryId = pickDuplicate(existingBySourceId.get(contentSourceId));
      if (dupEntryId !== undefined) {
        consumeFromBucket(existingFingerprints, fingerprintByEntryId.get(dupEntryId), dupEntryId);
      }
    }
    if (dupEntryId !== undefined) {
      // const alias: the narrowed type must survive into the payments
      // closure below (narrowing on a `let` resets inside closures).
      const dupId = dupEntryId;
      result.duplicates++;
      noteSubledgerGap(t);
      if (!entriesWithPayments.has(dupId)) {
        const { link: dupLink, unmatchedPayee: dupUnmatched } = derivePaymentLink(
          t,
          resolved[0]!.accountId,
          vendorIdByName,
        );
        if (dupLink) {
          // The earlier run posted this block GL-only because the payee
          // matched nobody then; it matches now, so write the missing
          // payments row against the already-posted entry. This is what
          // makes "create the vendor, re-import the same file" actually
          // repair 1099/payroll totals.
          try {
            await tx.transaction(async (inner) => {
              await inner.insert(paymentsTable).values({
                companyId: ctx.companyId,
                paymentType: dupLink.paymentType,
                customerId:
                  dupLink.paymentType === 'customer_received' ? dupLink.counterpartyId : null,
                vendorId: dupLink.paymentType === 'vendor_sent' ? dupLink.counterpartyId : null,
                paymentDate: t.date,
                paymentMethod: dupLink.method,
                reference: t.reference ?? null,
                bankAccountId: dupLink.bankAccountId,
                amount: dupLink.amount,
                memo: t.memo ?? null,
                status: 'posted',
                postedJournalEntryId: dupId,
              });
            });
            entriesWithPayments.add(dupId);
            result.paymentsBackfilled++;
          } catch (err) {
            // A warning, NOT an error. `errors` is contractually the blocks
            // that did not post, and the completion screen renders its length
            // as "N transactions skipped" -- but this block's journal entry is
            // already on the ledger (it was just counted as a duplicate).
            // Reporting it as skipped invites the CPA to hand-enter the
            // transaction a second time and double-book the register. Nothing
            // was skipped here; only the subledger row is missing.
            result.warnings.push(
              `row ${t.rowNumber} (${t.qbType}): this transaction is already posted to the ledger, ` +
                `but adding its payments-subledger row failed ` +
                `(${err instanceof Error ? err.message : String(err)}) -- the general ledger is ` +
                `correct and nothing was skipped, but 1099 and payroll totals will not include ` +
                `this payment. Do NOT re-enter the transaction.`,
            );
          }
        } else if (dupUnmatched) {
          // Still unlinked on re-import: keep disclosing the shortfall so
          // "N duplicates skipped" can't read as fixed while 1099 totals
          // stay short.
          noteUnlinkedPayee(dupUnmatched, t.lines[0]?.amount ?? '0.0000');
        }
      }
      const dateRefKey = dateRefKeyByEntryId.get(dupId);
      if (dateRefKey !== undefined) {
        // This exact copy is accounted for; don't let a later block that
        // legitimately shares its date+reference trip the edited-transaction
        // disclosure.
        const n = existingByDateRef.get(dateRefKey) ?? 0;
        if (n > 1) existingByDateRef.set(dateRefKey, n - 1);
        else existingByDateRef.delete(dateRefKey);
      }
      // Same reasoning for the two date-independent indexes: a recurring
      // payment that repeats verbatim month after month (or six identical
      // deposits) must not make its own already-imported twin look like an
      // edit of this block.
      consumeFromBucket(existingByDatelessFp, datelessFpByEntryId.get(dupId), dupId);
      for (const key of bankSideKeysByEntryId.get(dupId) ?? []) {
        consumeFromBucket(existingByBankSide, key, dupId);
      }
      continue;
    }

    // Closed-period pre-check (after the duplicate guard so a re-import of a
    // file whose entries predate a later year-end close still reads as
    // duplicates, not errors). The DB trigger remains the enforcement of
    // record; this check exists so the failure is a per-row skip instead of
    // a mid-transaction abort.
    if (closedThrough !== null && t.date <= closedThrough) {
      result.skipped++;
      result.errors.push({
        rowNumber: t.rowNumber,
        qbType: t.qbType,
        reason: `cannot post to closed period (entry date ${t.date} is on or before closed-through ${closedThrough})`,
      });
      continue;
    }

    const { link: paymentLink, unmatchedPayee } = derivePaymentLink(
      t,
      resolved[0]!.accountId,
      vendorIdByName,
    );

    try {
      // Savepoint per block: any SQL failure inside postEntry (a trigger, a
      // constraint) must roll back just this block. Without it the error --
      // even though caught right here -- aborts the outer Postgres
      // transaction, every later statement fails with 25P02, and the driver
      // rolls back the entire import at commit time.
      await tx.transaction(async (inner) => {
        const entry = await postEntry(inner, { companyId: ctx.companyId, userId: ctx.userId }, {
          entryDate: t.date,
          sourceType: t.sourceType,
          // Rename-proof duplicate provenance, derived from the file's own
          // account names and amounts -- see importSourceId.
          sourceId: contentSourceId,
          memo: t.memo,
          reference: t.reference,
          lines,
        });
        if (paymentLink) {
          await inner.insert(paymentsTable).values({
            companyId: ctx.companyId,
            paymentType: paymentLink.paymentType,
            customerId:
              paymentLink.paymentType === 'customer_received' ? paymentLink.counterpartyId : null,
            vendorId:
              paymentLink.paymentType === 'vendor_sent' ? paymentLink.counterpartyId : null,
            paymentDate: t.date,
            paymentMethod: paymentLink.method,
            reference: t.reference ?? null,
            bankAccountId: paymentLink.bankAccountId,
            amount: paymentLink.amount,
            memo: t.memo ?? null,
            status: 'posted',
            postedJournalEntryId: entry.id,
          });
        }
      });
      result.posted++;
      noteSubledgerGap(t);
      if (t.reference && (existingByDateRef.get(`${t.date} ${t.reference}`) ?? 0) > 0) {
        // Same date + reference as a pre-existing entry, but different
        // content (the fingerprint didn't match): the signature of a
        // transaction edited in QuickBooks after an earlier import. Both
        // versions are now on the ledger -- say so, because nothing else
        // will.
        result.warnings.push(
          `row ${t.rowNumber}: ${t.qbType} ref "${t.reference}" on ${t.date} posted as a new ` +
            `entry, but an entry with the same date and reference already exists with different ` +
            `amounts/accounts. If this transaction was edited in QuickBooks after an earlier ` +
            `import, the previous version is still on the ledger -- review and reverse it.`,
        );
      } else if (t.reference) {
        // Identical content under the same reference on a DIFFERENT day: the
        // signature of a date correction in QuickBooks. Every date-bearing
        // identity (fingerprint, source_id stamp, date+reference index) misses
        // that edit, so without this the second copy lands on the ledger in
        // total silence and the month's bank rec is off by its amount.
        const movedId = (
          existingByDatelessFp.get(datelessFingerprint(t.reference, t.memo, signedLines)) ?? []
        ).find((id) => entryDateById.get(id) !== t.date);
        if (movedId !== undefined) {
          result.warnings.push(
            `row ${t.rowNumber}: ${t.qbType} ref "${t.reference}" posted as a new entry on ` +
              `${t.date}, but an entry with the same reference, amounts and accounts already ` +
              `exists dated ${entryDateById.get(movedId)}. If this transaction's date was ` +
              `corrected in QuickBooks after an earlier import, the previous version is still ` +
              `on the ledger -- review and reverse it.`,
          );
        }
      } else if (
        (existingByBankSide.get(
          bankSideKey(t.date, signedLines[0]!.accountId, signedLines[0]!.signedAmount),
        ) ?? []).length > 0
      ) {
        // No reference to match on -- QBD writes no DOCNUM for DEPOSIT,
        // TRANSFER or most CCARD blocks, which are exactly the ones a
        // bookkeeper re-categorises. An existing reference-less entry on the
        // same date hitting the same account for the same amount is the
        // signature of that edit: the bank side is untouched while the
        // category leg moved, so both duplicate identities miss.
        result.warnings.push(
          `row ${t.rowNumber}: ${t.qbType} on ${t.date} posted as a new entry, but an existing ` +
            `entry on that date already posts ${signedLines[0]!.signedAmount} to the same ` +
            `account with different offsetting accounts/amounts. This transaction carries no ` +
            `reference number, so if it was re-categorised in QuickBooks after an earlier ` +
            `import, the previous version is still on the ledger -- review and reverse it.`,
        );
      }
      if (paymentLink) {
        result.paymentsLinked++;
      } else if (unmatchedPayee) {
        // Posted to the GL, but no payments-subledger row: aggregate per
        // payee so the result can disclose exactly whose 1099/payroll
        // totals are short instead of leaving only a count difference.
        noteUnlinkedPayee(unmatchedPayee, t.lines[0]?.amount ?? '0.0000');
      }
    } catch (err) {
      result.skipped++;
      const reason =
        err instanceof PostingError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      result.errors.push({ rowNumber: t.rowNumber, qbType: t.qbType, reason });
    }
  }

  // A/R + A/P subledger disclosure. Invoices, credit memos and bills post
  // correct journal entries, but the import creates no invoices/bills rows
  // behind them: a QBD transaction export carries no invoice<->payment
  // linkage, so KPBooks would have to invent which document each payment
  // settled -- and a subledger full of guesses is worse than an empty one.
  // The consequence is invisible without this note: the Balance Sheet shows a
  // real A/R (or A/P) balance from the control account while A/R Aging, A/P
  // Aging, customer statements, Receive Payment and Pay Bills read the
  // document tables and render nothing at all. Emitted at most once per
  // commit and count-free, so the client-side merge collapses the copies the
  // chunked commit produces into a single note.
  if (arDocuments > 0 || customerPayments > 0) {
    result.warnings.push(
      'Invoices, credit memos and customer payments in this file posted to the general ledger ' +
        'only. An IIF export does not say which invoice each payment paid, so no A/R documents ' +
        'were created: Accounts Receivable is correct on the Trial Balance and Balance Sheet, but ' +
        'A/R Aging and customer statements show only invoices and payments entered in KPBooks. ' +
        'Re-enter any still-open invoices by hand to work the A/R subledger.',
    );
  }
  if (apDocuments > 0) {
    result.warnings.push(
      'Bills, item receipts and vendor credits in this file posted to the general ledger only. ' +
        'No A/P documents were created (the export carries no bill-to-payment linkage): Accounts ' +
        'Payable is correct on the Trial Balance and Balance Sheet, but A/P Aging and Pay Bills ' +
        'show only bills entered in KPBooks. Re-enter any still-unpaid bills by hand.',
    );
  }

  result.unlinkedPayees = Array.from(unlinkedByPayee.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => ({ name: a.name, count: a.count, total: microsToDecimal(a.totalMicros) }));

  return result;
}

function amountToMicros(s: string): bigint {
  // s is already validated to /^\d+\.\d{4}$/ shape (positive).
  const [whole = '0', frac = '0000'] = s.split('.');
  return BigInt(whole) * 10000n + BigInt(frac);
}

/** Signed variant for the parser's canonical "-123.4500" strings. */
function signedAmountToMicros(s: string): bigint {
  return s.startsWith('-') ? -amountToMicros(s.slice(1)) : amountToMicros(s);
}

/** 4dp-micros bigint -> human decimal string ("100" -> "0.0100"). */
function microsToDecimal(m: bigint): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  return `${neg ? '-' : ''}${abs / 10000n}.${(abs % 10000n).toString().padStart(4, '0')}`;
}
