/**
 * Shared CSV export for reports.
 *
 * Excel is where these numbers actually get used, so two details matter:
 *   1. A UTF-8 BOM. Without it Excel decodes CSV as the system codepage and
 *      mangles every accented character — "Café Sales" becomes "CafÃ© Sales".
 *      Now that account and customer names run through a Spanish UI, that is
 *      not hypothetical.
 *   2. CRLF line endings, which Excel expects.
 */

/**
 * A plain decimal literal — the one shape the injection guard must let through.
 * "-1234.56" is a negative number in every spreadsheet, never a formula, and
 * quoting it would land every credit balance in Excel as text that won't sum.
 */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/** Escapes one field per RFC 4180: quote it if it could confuse a parser. */
function escapeField(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  // A leading =, +, -, or @ makes Excel treat the cell as a FORMULA. Account
  // names are user data, so prefix those with a single quote to neutralize
  // CSV-injection rather than executing whatever a customer typed. Numbers are
  // exempt: a report full of negative amounts is the normal case, and they have
  // to arrive as numbers.
  const safe = /^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows.map((r) => r.map(escapeField).join(',')).join('\r\n');
}

/** Builds a CSV file and hands it to the browser as a download. */
export function downloadCsv(
  filename: string,
  rows: Array<Array<string | number | null | undefined>>,
): void {
  const BOM = '\ufeff';
  const blob = new Blob([BOM + toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick — revoking synchronously can cancel the download
  // in Safari before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Filename stem like "profit-and-loss_2026-01-01_2026-08-19". Callers add the
 * company name themselves when it is useful; we keep punctuation out so the
 * result is safe on Windows, macOS, and Linux alike.
 */
export function reportFilename(base: string, ...parts: Array<string | undefined>): string {
  return [base, ...parts.filter(Boolean)]
    .join('_')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-');
}

/* ------------------------------------------------------------------ *
 * Shared report shapes + display formatting
 *
 * These live here rather than in ReportExport.tsx so the PDF writer can
 * reach them without importing a React component — the CSV and the PDF
 * are two renderings of the same rows and the same header block, and
 * neither should own the definitions.
 * ------------------------------------------------------------------ */

/** One report line. Numbers stay unformatted so Excel can sum the column. */
export type CsvRow = Array<string | number | null | undefined>;

export interface ReportMeta {
  /** Already-translated report name. */
  title: string;
  /** Range reports pass both; as-of reports pass `asOf` instead. */
  start?: string;
  end?: string;
  asOf?: string;
  /** Already-translated basis label. Omitted where a report has no basis. */
  basis?: string;
  /**
   * Extra label/value context lines — an account filter, a horizon, a
   * classification filter. Anything that changes which rows are below and
   * would otherwise be invisible in the file.
   */
  extra?: CsvRow[];
}

/**
 * True for a bare decimal literal. Drives right-alignment and digit grouping
 * in the PDF: a cell that is a number gets the number treatment, and a cell
 * that merely contains digits ("31–60", "1099-NEC") does not.
 */
export function isNumericCell(value: unknown): boolean {
  return typeof value === 'number' || PLAIN_NUMBER.test(String(value ?? ''));
}

/**
 * "1234.00" → "1,234.00". Groups the integer part and leaves the fraction
 * exactly as the caller wrote it, so a 2-dp money string stays money and a
 * 4-dp tax rate stays a rate. No currency symbol: like QuickBooks' own PDFs,
 * the column heading says what the number is.
 *
 * Whole numbers are left alone on purpose. Every figure in this app arrives
 * through csvMoney and therefore carries cents, so anything without a decimal
 * point is an identifier or a count — and an account code separated into
 * "4,000" is simply wrong.
 */
export function groupDigits(value: string | number): string {
  const s = String(value);
  if (!isNumericCell(s) || !s.includes('.')) return s;
  const negative = s.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? s.slice(1) : s).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${frac}`;
}

/**
 * "2026-08-25" → "August 25, 2026" (or "25 de agosto de 2026"). Parsed as UTC
 * so a date-only string never slips a day backwards west of Greenwich, and
 * handed back unchanged if it is not a plain ISO date.
 */
export function formatLongDate(iso: string | undefined, language: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}
