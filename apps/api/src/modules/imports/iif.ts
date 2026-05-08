import {
  type Database,
  accounts as accountsTable,
  customers as customersTable,
  vendors as vendorsTable,
} from '@kpbooks/db';
import { and, eq, inArray } from 'drizzle-orm';
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
 * Other sections (TRNS+SPL transactions, INVITEM, EMP, CLASS, etc.) are
 * ignored for v1. We also ignore subaccounts (parent-child) -- everything
 * lands flat. That keeps the slice tight; transaction + hierarchy support
 * is a follow-up slice.
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
}

export interface ParsedCustomer {
  displayName: string;
  companyName?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  notes?: string | undefined;
  defaultTermsDays?: number | undefined;
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
  'CREDIT CARD CREDIT': { sourceType: 'bank_transaction', posts: true },
  'CCARD CREDIT': { sourceType: 'bank_transaction', posts: true },
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
  // Non-posting documents.
  ESTIMATE: { sourceType: 'import', posts: false },
  'SALES ORDER': { sourceType: 'import', posts: false },
  'PURCHASE ORDER': { sourceType: 'import', posts: false },
  PURCHORD: { sourceType: 'import', posts: false },
  SALESORD: { sourceType: 'import', posts: false },
  STATEMENT: { sourceType: 'import', posts: false },
};

function lookupTrnsType(
  raw: string,
): { sourceType: ParsedTransaction['sourceType']; posts: boolean } {
  const upper = raw.toUpperCase();
  return TRNSTYPE_MAP[upper] ?? { sourceType: 'import', posts: true };
}

/** Parse "01/15/2026" / "1/15/2026" / "01/15/26" / "2026-01-15" -> "YYYY-MM-DD". */
export function normaliseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const month = parseInt(m[1]!, 10);
  const day = parseInt(m[2]!, 10);
  let year = parseInt(m[3]!, 10);
  if (m[3]!.length === 2) {
    // Two-digit years: 00-49 -> 2000s, 50-99 -> 1900s. QB exports are usually
    // recent; this matches QB's own convention.
    year = year < 50 ? 2000 + year : 1900 + year;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
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
  // Strip currency symbol, commas, spaces.
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
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

export function parseIif(text: string): IifPreview {
  const accounts: ParsedAccount[] = [];
  const customers: ParsedCustomer[] = [];
  const vendors: ParsedVendor[] = [];
  const transactions: ParsedTransaction[] = [];
  const transactionCounts: Record<string, number> = {};
  let nonPostingSkipped = 0;
  const unrecognizedSections: string[] = [];
  const warnings: string[] = [];
  const seenSections = new Set<string>();

  // Maps section tag -> column index map.
  const headers: Record<string, Record<string, number>> = {};

  // TRNS+SPL+ENDTRNS state machine.
  let pendingTransaction: ParsedTransaction | null = null;

  const finalisePending = (rowNo: number) => {
    if (!pendingTransaction) return;
    const { qbType, posts } = pendingTransaction;
    transactionCounts[qbType] = (transactionCounts[qbType] ?? 0) + 1;
    if (posts && pendingTransaction.lines.length >= 2) {
      transactions.push(pendingTransaction);
    } else if (!posts) {
      nonPostingSkipped++;
    } else {
      // posting type but <2 lines: malformed.
      warnings.push(
        `row ${rowNo}: ${qbType} block has only ${pendingTransaction.lines.length} line(s); skipping`,
      );
    }
    pendingTransaction = null;
  };

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (!raw.trim()) continue;
    const cells = raw.split('\t');
    const tag = cells[0] ?? '';

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

    if (!tag) continue;

    if (tag === 'ACCNT') {
      const cols = headers.ACCNT;
      if (!cols) {
        warnings.push(`row ${i + 1}: ACCNT row before ACCNT header; skipping`);
        continue;
      }
      const account = parseAccountRow(cells, cols, i + 1, warnings);
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
        continue;
      }
      // Implicit ENDTRNS for any pending transaction without one.
      if (pendingTransaction) {
        warnings.push(`row ${i + 1}: TRNS encountered while previous block had no ENDTRNS`);
        finalisePending(i + 1);
      }
      pendingTransaction = parseTrnsRow(cells, cols, i + 1, warnings);
      continue;
    }

    if (tag === 'SPL') {
      const cols = headers.SPL;
      if (!cols) {
        warnings.push(`row ${i + 1}: SPL row before SPL header; skipping`);
        continue;
      }
      if (!pendingTransaction) {
        warnings.push(`row ${i + 1}: SPL row outside a TRNS block; skipping`);
        continue;
      }
      const split = parseSplRow(cells, cols, i + 1, warnings);
      if (split) pendingTransaction.lines.push(split);
      continue;
    }

    if (tag === 'ENDTRNS') {
      finalisePending(i + 1);
      continue;
    }

    // Track unrecognized but valid-looking section tags so the user can see
    // what got dropped (e.g., INVITEM, CLASS, EMP).
    if (/^[A-Z][A-Z0-9_]*$/.test(tag)) {
      seenSections.add(tag);
    }
  }

  // Flush a trailing transaction if the file ended without ENDTRNS.
  if (pendingTransaction) {
    warnings.push('file ended with an unclosed TRNS block (no ENDTRNS)');
    finalisePending(lines.length);
  }

  for (const tag of ['INVITEM', 'EMP', 'CLASS', 'TIMEACT']) {
    if (seenSections.has(tag)) {
      const friendly =
        tag === 'INVITEM'
          ? 'inventory items'
          : tag === 'EMP'
            ? 'employees'
            : tag === 'CLASS'
              ? 'classes'
              : tag === 'TIMEACT'
                ? 'time activities'
                : tag;
      if (!unrecognizedSections.includes(friendly)) unrecognizedSections.push(friendly);
    }
  }

  // Assign suggested codes after all accounts parsed so we can group by type.
  const counters: Record<AccountType, number> = {
    asset: 0,
    liability: 0,
    equity: 0,
    revenue: 0,
    expense: 0,
  };
  for (const a of accounts) {
    counters[a.type]++;
    a.suggestedCode = String(TYPE_CODE_PREFIX[a.type] + counters[a.type] * 10);
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
  };
}

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
  // Credit card / line-of-credit.
  if (/\b(credit card|ccard|visa|amex|mastercard|discover)\b/.test(n)) {
    return { type: 'liability', subtype: 'credit_card' };
  }
  // A/R + A/P (specific phrases first to avoid false positives).
  if (/\b(accounts? receivable|a\/r)\b/.test(n) && !/payable/.test(n)) {
    return { type: 'asset', subtype: 'accounts_receivable' };
  }
  if (/\b(accounts? payable|a\/p)\b/.test(n) && !/receivable/.test(n)) {
    return { type: 'liability', subtype: 'accounts_payable' };
  }
  // Sales tax / payroll liabilities (other_current_liability bucket).
  if (/\b(sales tax|payroll|withholding|liability|payable)\b/.test(n)) {
    if (/long.?term|note|loan|mortgage/.test(n)) {
      return { type: 'liability', subtype: 'long_term_liability' };
    }
    return { type: 'liability', subtype: 'other_current_liability' };
  }
  if (/\b(loan|mortgage|note payable)\b/.test(n)) {
    return { type: 'liability', subtype: 'long_term_liability' };
  }
  // Fixed assets. Handle common plurals.
  if (/\b(equipment|vehicles?|trucks?|machinery|buildings?|furniture|fixtures?|land|computers?)\b/.test(n)) {
    return { type: 'asset', subtype: 'fixed_asset' };
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
  if (/\b(income|revenue|sales|service|fees? collected|consulting)\b/.test(n)) {
    return { type: 'revenue', subtype: 'income' };
  }
  // COGS.
  if (/\b(cost of goods|cogs|materials|labor|freight in|direct cost)\b/.test(n)) {
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

function parseTrnsRow(
  cells: string[],
  cols: Record<string, number>,
  rowNo: number,
  warnings: string[],
): ParsedTransaction | null {
  const cell = (col: string) => (cells[cols[col] ?? -1] ?? '').trim();
  const qbType = cell('TRNSTYPE');
  if (!qbType) {
    warnings.push(`row ${rowNo}: TRNS row missing TRNSTYPE; skipping`);
    return null;
  }
  const dateRaw = cell('DATE');
  const date = normaliseDate(dateRaw);
  if (!date) {
    warnings.push(`row ${rowNo}: invalid TRNS date "${dateRaw}"; skipping block`);
    return null;
  }
  const account = cell('ACCNT');
  if (!account) {
    warnings.push(`row ${rowNo}: TRNS row missing ACCNT; skipping block`);
    return null;
  }
  const amountRaw = cell('AMOUNT');
  const amount = normaliseAmount(amountRaw);
  if (amount == null) {
    warnings.push(`row ${rowNo}: invalid TRNS amount "${amountRaw}"; skipping block`);
    return null;
  }
  const docNum = cell('DOCNUM') || undefined;
  const memo = cell('MEMO') || undefined;
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
  const memo = cell('MEMO') || undefined;
  const name = cell('NAME') || undefined;
  const classRef = cell('CLASS') || undefined;
  return { account, amount, name, memo, classRef };
}

function parseAccountRow(
  cells: string[],
  cols: Record<string, number>,
  rowNo: number,
  warnings: string[],
): ParsedAccount | null {
  const cell = (col: string) => (cells[cols[col] ?? -1] ?? '').trim();
  const name = cell('NAME');
  if (!name) {
    warnings.push(`row ${rowNo}: ACCNT row missing NAME; skipping`);
    return null;
  }
  const qbType = cell('ACCNTTYPE') || 'EXP';
  const mapped = ACCNT_TYPE_MAP[qbType];
  if (!mapped) {
    warnings.push(
      `row ${rowNo}: unknown ACCNTTYPE "${qbType}" for "${name}" -- treating as expense`,
    );
  }
  const desc = cell('DESC');
  const final = mapped ?? { type: 'expense' as const, subtype: 'expense' as const };
  return {
    name,
    qbType,
    type: final.type,
    subtype: final.subtype,
    description: desc || undefined,
    suggestedCode: '', // assigned later
  };
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
  // QB IIF often uses PRINTAS for the company name and NAME for the contact.
  const printAs = cell('PRINTAS');
  const note = cell('NOTE');
  const phone = cell('PHONE1');
  const email = cell('EMAIL');
  const terms = cell('TERMS');
  const termsDays = parseTermsToDays(terms);
  return {
    displayName: name,
    companyName: printAs && printAs !== name ? printAs : undefined,
    email: email || undefined,
    phone: phone || undefined,
    notes: note || undefined,
    defaultTermsDays: termsDays,
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
  const printAs = cell('PRINTAS');
  const note = cell('NOTE');
  const phone = cell('PHONE1');
  const email = cell('EMAIL');
  const terms = cell('TERMS');
  const taxId = cell('TAXID');
  const eligible = cell('VENDOR1099').toUpperCase() === 'Y';
  return {
    displayName: name,
    companyName: printAs && printAs !== name ? printAs : undefined,
    email: email || undefined,
    phone: phone || undefined,
    notes: note || undefined,
    defaultTermsDays: parseTermsToDays(terms),
    is1099Vendor: eligible,
    taxId: taxId || undefined,
  };
}

function parseTermsToDays(terms: string): number | undefined {
  if (!terms) return undefined;
  // Common QB strings: "Net 30", "Net 15", "Due on receipt", "1% 10 Net 30".
  const m = terms.match(/Net\s*(\d+)/i);
  if (m && m[1]) return parseInt(m[1], 10);
  if (/due\s*on\s*receipt/i.test(terms)) return 0;
  return undefined;
}

// ------------------------- Commit -------------------------------------------

const CommitAccount = z.object({
  name: z.string().min(1).max(120),
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
});

const CommitCustomer = z.object({
  displayName: z.string().min(1).max(200),
  companyName: z.string().max(200).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
  defaultTermsDays: z.number().int().min(0).max(365).optional(),
});

const CommitVendor = z.object({
  displayName: z.string().min(1).max(200),
  companyName: z.string().max(200).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
  defaultTermsDays: z.number().int().min(0).max(365).optional(),
  is1099Vendor: z.boolean().default(false),
  taxId: z.string().max(40).optional(),
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
}

export interface CommitContext {
  companyId: string;
  userId: string;
}

/**
 * Skip-on-conflict policy: if a name (or account code) already exists in the
 * company, the row is skipped. The caller sees a count + a list of skipped
 * identifiers so they know what to fix manually. This keeps the import
 * idempotent -- a second run with the same file is a no-op.
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
  };

  // Account conflict detection: by code (unique within company) and by name.
  if (input.accounts.length > 0) {
    const codes = input.accounts.map((a) => a.code);
    const names = input.accounts.map((a) => a.name);
    const existing = await tx
      .select({ code: accountsTable.code, name: accountsTable.name })
      .from(accountsTable)
      .where(
        and(
          eq(accountsTable.companyId, ctx.companyId),
          inArray(accountsTable.code, codes),
        ),
      );
    const existingByCode = new Set(existing.map((r) => r.code));
    const existingByName = new Set(
      (
        await tx
          .select({ name: accountsTable.name })
          .from(accountsTable)
          .where(
            and(
              eq(accountsTable.companyId, ctx.companyId),
              inArray(accountsTable.name, names),
            ),
          )
      ).map((r) => r.name),
    );

    const usedCodesThisImport = new Set<string>();
    for (const a of input.accounts) {
      if (existingByCode.has(a.code) || usedCodesThisImport.has(a.code)) {
        result.accountsSkipped++;
        result.conflicts.push({
          kind: 'account',
          identifier: a.name,
          reason: `code ${a.code} already exists`,
        });
        continue;
      }
      if (existingByName.has(a.name)) {
        result.accountsSkipped++;
        result.conflicts.push({
          kind: 'account',
          identifier: a.name,
          reason: 'name already exists',
        });
        continue;
      }
      await tx.insert(accountsTable).values({
        companyId: ctx.companyId,
        code: a.code,
        name: a.name,
        type: a.type,
        subtype: a.subtype as never,
        currency: 'USD',
        description: a.description ?? null,
      });
      usedCodesThisImport.add(a.code);
      result.accountsCreated++;
    }
  }

  if (input.customers.length > 0) {
    const names = input.customers.map((c) => c.displayName);
    const existing = new Set(
      (
        await tx
          .select({ name: customersTable.displayName })
          .from(customersTable)
          .where(
            and(
              eq(customersTable.companyId, ctx.companyId),
              inArray(customersTable.displayName, names),
            ),
          )
      ).map((r) => r.name),
    );
    for (const c of input.customers) {
      if (existing.has(c.displayName)) {
        result.customersSkipped++;
        result.conflicts.push({
          kind: 'customer',
          identifier: c.displayName,
          reason: 'name already exists',
        });
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
      });
      result.customersCreated++;
    }
  }

  if (input.vendors.length > 0) {
    const names = input.vendors.map((v) => v.displayName);
    const existing = new Set(
      (
        await tx
          .select({ name: vendorsTable.displayName })
          .from(vendorsTable)
          .where(
            and(
              eq(vendorsTable.companyId, ctx.companyId),
              inArray(vendorsTable.displayName, names),
            ),
          )
      ).map((r) => r.name),
    );
    for (const v of input.vendors) {
      if (existing.has(v.displayName)) {
        result.vendorsSkipped++;
        result.conflicts.push({
          kind: 'vendor',
          identifier: v.displayName,
          reason: 'name already exists',
        });
        continue;
      }
      // 1099 invariant: tax ID required when flagged.
      if (v.is1099Vendor && !(v.taxId && v.taxId.length > 0)) {
        result.vendorsSkipped++;
        result.conflicts.push({
          kind: 'vendor',
          identifier: v.displayName,
          reason: '1099 vendor without tax ID -- skipped (add manually)',
        });
        continue;
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
      });
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
  errors: { rowNumber: number; qbType: string; reason: string }[];
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
  const result: TransactionCommitResult = { posted: 0, skipped: 0, errors: [] };
  if (input.transactions.length === 0) return result;

  // Build a lower-cased name -> id map for fast resolution. We rely on RLS
  // having scoped the tx to ctx.companyId already.
  const accountRows = await tx
    .select({ id: accountsTable.id, name: accountsTable.name, isActive: accountsTable.isActive })
    .from(accountsTable);
  const byName = new Map(accountRows.map((a) => [a.name.toLowerCase(), a]));

  for (const t of input.transactions) {
    if (!t.posts) {
      result.skipped++;
      continue;
    }

    // Resolve every line's account before posting.
    const resolved: { accountId: string; signedAmount: string; memo?: string | undefined }[] = [];
    let unresolved: string | null = null;
    let inactiveAccount: string | null = null;
    for (const line of t.lines) {
      const acc = byName.get(line.account.toLowerCase());
      if (!acc) {
        unresolved = line.account;
        break;
      }
      if (!acc.isActive) {
        inactiveAccount = line.account;
        break;
      }
      resolved.push({ accountId: acc.id, signedAmount: line.amount, memo: line.memo });
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
        });
        creditMicros += amountToMicros(positive);
      } else {
        lines.push({
          accountId: r.accountId,
          debit: r.signedAmount,
          currency: 'USD',
          fxRate: '1',
          memo: r.memo,
        });
        debitMicros += amountToMicros(r.signedAmount);
      }
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

    try {
      await postEntry(tx, { companyId: ctx.companyId, userId: ctx.userId }, {
        entryDate: t.date,
        sourceType: t.sourceType,
        memo: t.memo,
        reference: t.reference,
        lines,
      });
      result.posted++;
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

  return result;
}

function amountToMicros(s: string): bigint {
  // s is already validated to /^\d+\.\d{4}$/ shape (positive).
  const [whole = '0', frac = '0000'] = s.split('.');
  return BigInt(whole) * 10000n + BigInt(frac);
}
