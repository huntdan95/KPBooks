/**
 * Excel front end for the QuickBooks Journal report.
 *
 * "Export to Excel" in QuickBooks produces a workbook, not a clean grid:
 *   - Sheet 1 is QuickBooks' own "QuickBooks Desktop Export Tips" page (prose
 *     plus a screenshot). The report is on another sheet, so we pick the sheet
 *     by CONTENT — the one carrying the report header — never by index.
 *   - Narrow blank spacer columns sit between the real ones.
 *   - Dates arrive as Excel serial numbers / Date objects, not text.
 *   - "Blank" cells are frequently a single space.
 * Everything is flattened to a string matrix here so parseJournalRows sees the
 * same shape whether the user exported CSV or Excel.
 */
import ExcelJS from 'exceljs';
import type { IifPreview } from './iif.js';
import { parseJournalRows, type JournalReportOptions } from './journal-report.js';

/** Sheets QuickBooks adds that never contain report data. */
const IGNORED_SHEET_PATTERNS = [/export\s*tips/i, /instructions/i];

/** Flattens one ExcelJS cell value to the string the row parser expects. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // Format in UTC: ExcelJS decodes serials against UTC, and using local
    // getters here would shift dates a day for anyone west of Greenwich.
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // Formula cells: use the cached result, not the formula text.
    if ('result' in v) return cellToString(v.result);
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('richText' in v && Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('');
    }
    if ('error' in v) return '';
  }
  return String(value);
}

/** Does this row matrix contain a Journal report header? */
function looksLikeJournal(rows: string[][]): boolean {
  return rows.slice(0, 40).some((cells) => {
    const norm = cells.map((c) => (c ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''));
    return (
      norm.includes('account') &&
      (norm.includes('debit') || norm.includes('credit') || norm.includes('amount'))
    );
  });
}

function sheetToRows(ws: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  const lastRow = ws.actualRowCount ? ws.rowCount : ws.rowCount;
  for (let r = 1; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    const width = Math.max(ws.columnCount, row.cellCount);
    for (let c = 1; c <= width; c++) {
      cells.push(cellToString(row.getCell(c).value).trim());
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Parses a QuickBooks Journal report workbook. Returns the same preview shape
 * as the IIF and CSV parsers so the shared commit path consumes it unchanged.
 */
export async function parseJournalXlsx(
  data: Buffer | ArrayBuffer,
  opts?: JournalReportOptions,
): Promise<IifPreview> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as never);

  const candidates: { name: string; rows: string[][] }[] = [];
  wb.eachSheet((ws) => {
    if (IGNORED_SHEET_PATTERNS.some((re) => re.test(ws.name))) return;
    candidates.push({ name: ws.name, rows: sheetToRows(ws) });
  });

  if (candidates.length === 0) {
    return parseJournalRows([], opts);
  }

  // Prefer a sheet that actually carries the report header; fall back to the
  // largest sheet so a renamed tab still gets a real error message from the
  // row parser rather than a silent empty import.
  const chosen =
    candidates.find((c) => looksLikeJournal(c.rows)) ??
    candidates.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));

  const preview = parseJournalRows(chosen.rows, opts);
  if (candidates.length > 1 && preview.transactions.length > 0) {
    preview.warnings.push(
      `Read the "${chosen.name}" sheet. Other sheets in this workbook were ignored.`,
    );
  }
  return preview;
}
