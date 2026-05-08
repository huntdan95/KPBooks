/**
 * Bank CSV parser. Handles common formats:
 *   - Date,Description,Amount,Balance      (Wells Fargo, Capital One)
 *   - Date,Description,Debit,Credit,Balance (Chase, Bank of America)
 *   - Posted Date,Description,Amount,...   (most others)
 *
 * Auto-detects which columns hold what by sniffing the header row. Falls
 * back to a permissive "first matching column" rule. Rows that can't be
 * parsed are reported with their line number so the user can fix the file.
 */

export interface ParsedBankRow {
  /** 1-based line number from the CSV (excluding header). */
  rowNumber: number;
  date: string; // YYYY-MM-DD
  description: string;
  /** Signed: positive = deposit, negative = withdrawal. */
  amount: string;
  /** Running balance from the CSV if provided. */
  balance?: string | undefined;
  /** Original CSV line stored for audit/debug. */
  rawLine: string;
}

export interface CsvParseResult {
  rows: ParsedBankRow[];
  warnings: string[];
  /** What columns the parser detected, useful for confirming in the UI. */
  detectedColumns: {
    date: number | null;
    description: number | null;
    amount: number | null;
    debit: number | null;
    credit: number | null;
    balance: number | null;
  };
}

const DATE_HEADER_PATTERNS = /^(date|posted\s*date|trans(action)?\s*date|posting\s*date)$/i;
const DESC_HEADER_PATTERNS = /^(description|memo|details?|payee|name|trans(action)?\s*description)$/i;
const AMOUNT_HEADER_PATTERNS = /^(amount|trans(action)?\s*amount)$/i;
const DEBIT_HEADER_PATTERNS = /^(debit|withdrawals?|out|amount\s*out)$/i;
const CREDIT_HEADER_PATTERNS = /^(credit|deposits?|in|amount\s*in)$/i;
const BALANCE_HEADER_PATTERNS = /^(balance|running\s*balance|ending\s*balance)$/i;

/**
 * RFC 4180-ish CSV split with quote handling. Doesn't try to handle
 * embedded newlines inside quoted fields (extremely rare in bank CSVs).
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === ',') {
        cells.push(current);
        current = '';
      } else if (ch === '"' && current === '') {
        inQuotes = true;
      } else {
        current += ch;
      }
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

function findColumn(headers: string[], pattern: RegExp): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (pattern.test(headers[i] ?? '')) return i;
  }
  return null;
}

/** Reuses the IIF date/amount normalisers since they handle the same formats. */
function normaliseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})$/);
  if (!m) return null;
  const month = parseInt(m[1]!, 10);
  const day = parseInt(m[2]!, 10);
  let year = parseInt(m[3]!, 10);
  if (m[3]!.length === 2) year = year < 50 ? 2000 + year : 1900 + year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normaliseAmount(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole = '0', frac = ''] = s.split('.');
  const padded = (frac + '0000').slice(0, 4);
  return `${negative ? '-' : ''}${whole}.${padded}`;
}

export function parseBankCsv(text: string): CsvParseResult {
  const warnings: string[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    return {
      rows: [],
      warnings: ['CSV needs at least a header row + one data row.'],
      detectedColumns: {
        date: null,
        description: null,
        amount: null,
        debit: null,
        credit: null,
        balance: null,
      },
    };
  }

  const headerCells = splitCsvLine(lines[0] ?? '');
  const detected = {
    date: findColumn(headerCells, DATE_HEADER_PATTERNS),
    description: findColumn(headerCells, DESC_HEADER_PATTERNS),
    amount: findColumn(headerCells, AMOUNT_HEADER_PATTERNS),
    debit: findColumn(headerCells, DEBIT_HEADER_PATTERNS),
    credit: findColumn(headerCells, CREDIT_HEADER_PATTERNS),
    balance: findColumn(headerCells, BALANCE_HEADER_PATTERNS),
  };

  if (detected.date === null) {
    return {
      rows: [],
      warnings: ['No date column found. Expected one of: Date, Posted Date, Transaction Date.'],
      detectedColumns: detected,
    };
  }
  if (detected.description === null) {
    return {
      rows: [],
      warnings: ['No description column found. Expected: Description, Memo, Details, Payee.'],
      detectedColumns: detected,
    };
  }
  if (detected.amount === null && (detected.debit === null || detected.credit === null)) {
    return {
      rows: [],
      warnings: [
        'Need either an Amount column, or both Debit and Credit columns.',
      ],
      detectedColumns: detected,
    };
  }

  const rows: ParsedBankRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const cells = splitCsvLine(rawLine);

    const dateRaw = cells[detected.date] ?? '';
    const date = normaliseDate(dateRaw);
    if (!date) {
      warnings.push(`row ${i + 1}: invalid date "${dateRaw}"; skipping`);
      continue;
    }

    const description = (cells[detected.description] ?? '').trim();
    if (!description) {
      warnings.push(`row ${i + 1}: empty description; skipping`);
      continue;
    }

    let amount: string | null = null;
    if (detected.amount !== null) {
      amount = normaliseAmount(cells[detected.amount] ?? '');
    } else if (detected.debit !== null && detected.credit !== null) {
      // Bank CSVs that split into Debit/Credit columns: at most one populated
      // per row. Debit typically means money OUT (withdrawal -> negative
      // amount); Credit typically means money IN (deposit -> positive).
      const debit = normaliseAmount(cells[detected.debit] ?? '');
      const credit = normaliseAmount(cells[detected.credit] ?? '');
      if (debit && Number(debit) !== 0) {
        amount = debit.startsWith('-') ? debit : `-${debit}`;
      } else if (credit && Number(credit) !== 0) {
        amount = credit;
      }
    }

    if (!amount || Number(amount) === 0) {
      warnings.push(`row ${i + 1}: zero or invalid amount; skipping`);
      continue;
    }

    const balance =
      detected.balance !== null ? normaliseAmount(cells[detected.balance] ?? '') ?? undefined : undefined;

    rows.push({
      rowNumber: i + 1,
      date,
      description,
      amount,
      balance,
      rawLine,
    });
  }

  return { rows, warnings, detectedColumns: detected };
}
