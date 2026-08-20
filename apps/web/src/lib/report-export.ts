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
