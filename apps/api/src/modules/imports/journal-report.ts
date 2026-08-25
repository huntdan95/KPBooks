/**
 * QuickBooks "Journal" report importer (CSV and Excel).
 *
 * WHY THIS EXISTS
 * ---------------
 * QuickBooks Desktop cannot export transactions to IIF — IIF transaction
 * support is import-only. The Journal report (Reports > Accountant & Taxes >
 * Journal) is the one built-in way to get the whole ledger out: it renders
 * EVERY transaction as debits and credits, one row per split line, which maps
 * almost exactly onto ParsedTransaction/ParsedSplit. So this parser emits the
 * same IifPreview shape the IIF parser does, and the existing preview ->
 * commit path handles the rest unchanged: duplicate fingerprinting, balance
 * enforcement, missing-account creation, closed-period checks.
 *
 * WHAT A REAL EXPORT LOOKS LIKE (verified against a customer's file)
 * ------------------------------------------------------------------
 * The .xlsx that "Export to Excel" produces is NOT a clean grid:
 *   - Two worksheets. The first is QuickBooks' own "QuickBooks Desktop Export
 *     Tips" page (prose + a screenshot); the report lives on the second.
 *   - Columns are interleaved with narrow blank spacer columns, so the real
 *     fields land on B, D, F, H, J, L, N, P, R.
 *   - Dates are Excel SERIAL NUMBERS (46027), not text.
 *   - Blank-looking cells are often a single space, not empty.
 *   - Each transaction is one header row plus continuation rows whose
 *     Trans #/Type/Date/Num are blank, then a "TOTAL" row.
 * Columns are therefore located BY HEADER NAME and spacer columns ignored;
 * nothing here may depend on column position.
 */
import type { IifPreview, ParsedSplit, ParsedTransaction } from './iif.js';

/** Ledger scale: NUMERIC(19,4). */
const SCALE = 4;

/**
 * QuickBooks Journal report "Type" values -> journal_entries.source_type.
 * These are report display names, which differ from IIF TRNSTYPE codes
 * ("Bill Pmt -Check" here vs "BILLPMT" there), so this is deliberately its
 * own map rather than a reuse of the IIF one.
 *
 * posts:false marks non-posting documents. QuickBooks normally omits them
 * from the Journal report, but a customized report can include them and they
 * must never reach the ledger.
 */
const TYPE_MAP: Record<string, { sourceType: ParsedTransaction['sourceType']; posts: boolean }> = {
  invoice: { sourceType: 'invoice', posts: true },
  'credit memo': { sourceType: 'invoice', posts: true },
  'sales receipt': { sourceType: 'invoice', posts: true },
  'statement charge': { sourceType: 'invoice', posts: true },
  payment: { sourceType: 'payment', posts: true },
  'receive payment': { sourceType: 'payment', posts: true },
  bill: { sourceType: 'bill', posts: true },
  'bill pmt -check': { sourceType: 'payment', posts: true },
  'bill pmt -cc': { sourceType: 'payment', posts: true },
  'bill pmt -credit card': { sourceType: 'payment', posts: true },
  'vendor credit': { sourceType: 'bill', posts: true },
  'credit card charge': { sourceType: 'bank_transaction', posts: true },
  'credit card credit': { sourceType: 'bank_transaction', posts: true },
  check: { sourceType: 'bank_transaction', posts: true },
  deposit: { sourceType: 'bank_transaction', posts: true },
  transfer: { sourceType: 'bank_transaction', posts: true },
  'general journal': { sourceType: 'manual', posts: true },
  'journal entry': { sourceType: 'manual', posts: true },
  paycheck: { sourceType: 'payroll', posts: true },
  'payroll check': { sourceType: 'payroll', posts: true },
  'liability check': { sourceType: 'payroll', posts: true },
  'liability adjustment': { sourceType: 'payroll', posts: true },
  'inventory adjustment': { sourceType: 'manual', posts: true },
  'sales tax payment': { sourceType: 'payment', posts: true },
  estimate: { sourceType: 'manual', posts: false },
  'sales order': { sourceType: 'manual', posts: false },
  'purchase order': { sourceType: 'manual', posts: false },
};

/** Header aliases, lower-cased with punctuation stripped. */
const COLUMN_ALIASES: Record<string, string[]> = {
  transNum: ['trans', 'transno', 'transnum', 'transactionnum', 'transaction'],
  type: ['type', 'transactiontype'],
  date: ['date'],
  docNum: ['num', 'number', 'docnum', 'refnumber', 'ref'],
  name: ['name', 'source', 'sourcename', 'payee', 'customer', 'vendor'],
  memo: ['memo', 'description', 'memodescription'],
  account: ['account', 'accountname', 'splitaccount'],
  debit: ['debit'],
  credit: ['credit'],
  amount: ['amount'],
  classRef: ['class'],
};

const normalizeHeader = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/* ------------------------------- CSV front end ---------------------------- */

/** RFC 4180 splitter: quoted fields, "" escapes, embedded commas and newlines. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Strip a UTF-8 BOM; Excel adds one on re-save and it would otherwise become
  // part of the first header cell and break header matching.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // ignore; the \n case closes the row
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ------------------------------- value parsing ---------------------------- */

/**
 * Money as a QuickBooks report writes it: "1,234.56", "$1,234.56",
 * "(1,234.56)" for negative, "-1,234.56", or blank. Returns a signed decimal
 * string at ledger scale, or null when the cell holds no number.
 */
export function parseReportAmount(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const parenNegative = /^\(.*\)$/.test(s);
  let body = s.replace(/^\((.*)\)$/, '$1').replace(/[$\s,]/g, '');
  if (!body || body === '-' || body === '.') return null;
  let negative = parenNegative;
  if (body.startsWith('-')) {
    negative = !parenNegative;
    body = body.slice(1);
  }
  if (!/^\d*(\.\d+)?$/.test(body) || body === '' || body === '.') return null;
  const [whole = '0', frac = ''] = body.split('.');
  const value = `${whole || '0'}.${(frac + '0000').slice(0, SCALE)}`;
  return negative && !/^0\.0*$/.test(value) ? `-${value}` : value;
}

/**
 * Excel stores dates as a serial day count. The 1900 system (what Windows
 * Excel and QuickBooks emit) has a deliberate bug: it treats 1900 as a leap
 * year, so serials from March 1900 on are one day ahead of reality. Using
 * 1899-12-30 as the epoch absorbs that off-by-one for every date after
 * 1900-03-01, which covers every date a bookkeeping file will ever contain.
 */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 500000) return null;
  const ms = Math.round(serial * 86400000);
  const dt = new Date(Date.UTC(1899, 11, 30) + ms);
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getUTCFullYear();
  if (y < 1900 || y > 2200) return null;
  return `${y}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** M/D/YYYY, MM/DD/YYYY, M/D/YY, YYYY-MM-DD, M-D-YYYY, or an Excel serial. */
export function parseReportDate(raw: string, dayFirst = false): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return isRealDate(+iso[1]!, +iso[2]!, +iso[3]!) ? s : null;
  // A bare 4-6 digit integer is an Excel serial that reached us as text.
  if (/^\d{4,6}$/.test(s)) return excelSerialToIso(Number(s));
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const a = +m[1]!;
  const b = +m[2]!;
  let year = +m[3]!;
  if (m[3]!.length === 2) year += year >= 70 ? 1900 : 2000;
  const month = dayFirst ? b : a;
  const day = dayFirst ? a : b;
  return isRealDate(year, month, day)
    ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    : null;
}

/**
 * Calendar validity, not just range checks. QuickBooks will not emit 2/30, but
 * hand-edited exports do, and an impossible date aborts the whole import
 * transaction at the Postgres layer instead of failing a single row.
 */
function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const minor = (dec: string): bigint => {
  const neg = dec.startsWith('-');
  const [w = '0', f = ''] = (neg ? dec.slice(1) : dec).split('.');
  const v = BigInt((w || '0') + (f + '0000').slice(0, SCALE));
  return neg ? -v : v;
};
const fromMinor = (v: bigint): string => {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(SCALE + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -SCALE)}.${s.slice(-SCALE)}`;
};

/** Subtotal / grand-total rows, which must never become journal lines. */
function isTotalRow(cells: string[], accountCell: string): boolean {
  if (/^total\b/i.test(accountCell.trim())) return true;
  const firstText = cells.find((c) => (c ?? '').trim().length > 0)?.trim() ?? '';
  return /^total\b/i.test(firstText);
}

export interface JournalReportOptions {
  /** Interpret ambiguous dates as D/M/Y (non-US QuickBooks locales). */
  dateOrder?: 'mdy' | 'dmy';
}

/* --------------------------------- core ----------------------------------- */

/**
 * Parses a Journal report already reduced to a row matrix. Both the CSV and
 * the Excel front ends funnel through here so the two formats cannot drift.
 */
export function parseJournalRows(rows: string[][], opts?: JournalReportOptions): IifPreview {
  const dayFirst = opts?.dateOrder === 'dmy';
  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = [];
  const transactionCounts: Record<string, number> = {};
  const excludedTransactions: IifPreview['excludedTransactions'] = [];
  let nonPostingSkipped = 0;

  if (rows.length === 0) return empty(['The file is empty.']);

  // 1. Locate the header row. Title rows precede it and vary in count, and
  //    spacer columns mean the fields are not contiguous.
  let headerIndex = -1;
  let colIndex: Record<string, number> = {};
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const map: Record<string, number> = {};
    rows[i]!.forEach((cell, idx) => {
      const h = normalizeHeader(cell ?? '');
      if (!h) return;
      for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
        if (map[key] === undefined && aliases.includes(h)) map[key] = idx;
      }
    });
    if (map.account !== undefined && (map.debit !== undefined || map.amount !== undefined)) {
      headerIndex = i;
      colIndex = map;
      break;
    }
  }

  if (headerIndex === -1) {
    return empty([
      'Could not find the report header row. This does not look like a QuickBooks Journal ' +
        'report — it needs at least an "Account" column plus "Debit"/"Credit" or "Amount". ' +
        'In QuickBooks: Reports > Accountant & Taxes > Journal, then export.',
    ]);
  }
  if (colIndex.date === undefined) {
    return empty([
      'The report has no Date column. Add it via Customize Report > Display, then export again.',
    ]);
  }

  const cellAt = (cells: string[], key: string): string => {
    const idx = colIndex[key];
    return idx === undefined ? '' : (cells[idx] ?? '').trim();
  };

  // 2. Group rows into transactions. Continuation rows leave the header
  //    fields blank, so they inherit from the transaction they belong to.
  interface Group {
    rowNumber: number;
    key: string;
    type: string;
    date: string;
    docNum: string;
    name: string;
    memo: string;
    splits: { account: string; amount: string; name: string; memo: string; classRef: string }[];
  }
  const groups: Group[] = [];
  let current: Group | null = null;

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const cells = rows[i]!;
    const rowNumber = i + 1; // 1-based, for user-facing messages
    if (cells.every((c) => (c ?? '').trim() === '')) continue;

    const account = cellAt(cells, 'account');
    if (isTotalRow(cells, account)) continue;

    const transNum = cellAt(cells, 'transNum');
    const type = cellAt(cells, 'type');
    const date = cellAt(cells, 'date');

    const startsNew =
      current === null ||
      (colIndex.transNum !== undefined && transNum !== '' && transNum !== current.key) ||
      (colIndex.transNum === undefined && type !== '');

    if (startsNew) {
      current = {
        rowNumber,
        key: transNum || `${type}|${date}|${cellAt(cells, 'docNum')}|${rowNumber}`,
        type,
        date,
        docNum: cellAt(cells, 'docNum'),
        name: cellAt(cells, 'name'),
        memo: cellAt(cells, 'memo'),
        splits: [],
      };
      groups.push(current);
    }

    const g = current!;
    if (type && !g.type) g.type = type;
    if (date && !g.date) g.date = date;
    const rowDoc = cellAt(cells, 'docNum');
    if (rowDoc && !g.docNum) g.docNum = rowDoc;

    if (!account) continue; // spacer row inside a transaction

    let amount: string | null;
    if (colIndex.debit !== undefined || colIndex.credit !== undefined) {
      const d = parseReportAmount(cellAt(cells, 'debit'));
      const c = parseReportAmount(cellAt(cells, 'credit'));
      if (d === null && c === null) continue; // text-only row
      amount = fromMinor((d ? minor(d) : 0n) - (c ? minor(c) : 0n));
    } else {
      amount = parseReportAmount(cellAt(cells, 'amount'));
      if (amount === null) continue;
    }

    g.splits.push({
      account,
      amount,
      name: cellAt(cells, 'name') || g.name,
      memo: cellAt(cells, 'memo'),
      classRef: cellAt(cells, 'classRef'),
    });
  }

  // 3. Validate and convert.
  for (const g of groups) {
    const qbType = g.type || 'General Journal';
    transactionCounts[qbType] = (transactionCounts[qbType] ?? 0) + 1;

    const mapped = TYPE_MAP[qbType.toLowerCase().replace(/\s+/g, ' ').trim()];
    if (mapped && !mapped.posts) {
      nonPostingSkipped++;
      continue;
    }

    if (g.splits.length < 2) {
      excludedTransactions.push({
        rowNumber: g.rowNumber,
        qbType,
        reason: `only ${g.splits.length} line(s); a journal entry needs at least 2`,
      });
      continue;
    }

    const date = parseReportDate(g.date, dayFirst);
    if (!date) {
      excludedTransactions.push({
        rowNumber: g.rowNumber,
        qbType,
        reason: g.date ? `unreadable date "${g.date}"` : 'missing date',
      });
      continue;
    }

    const net = g.splits.reduce((acc, s) => acc + minor(s.amount), 0n);
    if (net !== 0n) {
      excludedTransactions.push({
        rowNumber: g.rowNumber,
        qbType,
        reason:
          `debits and credits differ by ${fromMinor(net)} — the export may be truncated or ` +
          `filtered; check this transaction in QuickBooks`,
      });
      continue;
    }

    const lines: ParsedSplit[] = g.splits.map((s) => ({
      account: s.account,
      amount: s.amount,
      ...(s.name ? { name: s.name } : {}),
      ...(s.memo ? { memo: s.memo } : {}),
      ...(s.classRef ? { classRef: s.classRef } : {}),
    }));

    transactions.push({
      rowNumber: g.rowNumber,
      qbType,
      sourceType: mapped?.sourceType ?? 'import',
      posts: true,
      date,
      ...(g.docNum ? { docNum: g.docNum } : {}),
      ...(g.memo ? { memo: g.memo } : {}),
      lines,
    });

    if (!mapped) {
      const w = `Unrecognized transaction type "${qbType}" — imported as a general journal entry.`;
      if (!warnings.includes(w)) warnings.push(w);
    }
  }

  if (transactions.length === 0 && excludedTransactions.length === 0) {
    warnings.push(
      'No transactions were found below the header row. If this was a summary-only report, ' +
        're-run it as Reports > Accountant & Taxes > Journal and export again.',
    );
  }

  return {
    accounts: [],
    customers: [],
    vendors: [],
    transactions,
    transactionCounts,
    nonPostingSkipped,
    missingAccounts: [],
    unrecognizedSections: [],
    warnings,
    excludedTransactions,
  };
}

/** CSV front end. */
export function parseJournalCsv(text: string, opts?: JournalReportOptions): IifPreview {
  return parseJournalRows(parseCsvRows(text), opts);
}

function empty(warnings: string[]): IifPreview {
  return {
    accounts: [],
    customers: [],
    vendors: [],
    transactions: [],
    transactionCounts: {},
    nonPostingSkipped: 0,
    missingAccounts: [],
    unrecognizedSections: [],
    warnings,
    excludedTransactions: [],
  };
}

/**
 * Reconciles Journal-report account names against the existing chart.
 *
 * The Journal report prints the LEAF name of a sub-account ("Carlos Arana"),
 * while the chart of accounts — and the IIF lists export that seeded it —
 * uses the full colon path ("Subcontractors:Carlos Arana"). Left alone, every
 * sub-account in the report would be treated as missing and a duplicate
 * top-level account created beside the real one, quietly splitting the chart
 * of accounts in two.
 *
 * A leaf is rewritten to its full path ONLY when exactly one existing account
 * ends in that leaf. Ambiguous leaves are returned instead of guessed, so the
 * preview can ask rather than silently pick the wrong account.
 */
export function resolveLeafAccountNames(
  preview: IifPreview,
  existingNames: Set<string>,
): { resolved: number; ambiguous: string[] } {
  const byLeaf = new Map<string, string[]>();
  for (const full of existingNames) {
    const leaf = full.includes(':') ? full.slice(full.lastIndexOf(':') + 1) : full;
    const key = leaf.trim().toLowerCase();
    const list = byLeaf.get(key);
    if (list) list.push(full);
    else byLeaf.set(key, [full]);
  }

  let resolved = 0;
  const ambiguous = new Set<string>();
  for (const txn of preview.transactions) {
    for (const line of txn.lines) {
      if (existingNames.has(line.account)) continue;
      if (line.account.includes(':')) continue; // already a path; leave it alone
      const matches = byLeaf.get(line.account.trim().toLowerCase());
      if (!matches || matches.length === 0) continue;
      if (matches.length > 1) {
        ambiguous.add(line.account);
        continue;
      }
      const full = matches[0]!;
      if (full === line.account) continue; // it IS a top-level account
      line.account = full;
      resolved++;
    }
  }

  if (resolved > 0) {
    preview.warnings.push(
      `Matched ${resolved} line(s) to existing sub-accounts by name — the Journal report ` +
        `prints only the last part of a sub-account name (for example "Carlos Arana" for ` +
        `"Subcontractors:Carlos Arana").`,
    );
  }
  if (ambiguous.size > 0) {
    preview.warnings.push(
      `These names match more than one account, so they were left as-is and will be offered ` +
        `as new accounts — pick the right one before committing: ${[...ambiguous].sort().join(', ')}.`,
    );
  }
  return { resolved, ambiguous: [...ambiguous].sort() };
}
