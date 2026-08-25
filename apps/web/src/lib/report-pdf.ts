/**
 * PDF rendering for reports.
 *
 * The same rows the CSV writes, laid out the way QuickBooks lays out a printed
 * report: a centred masthead naming the company, then the report name, then the
 * period, then the table — so a page that has been printed, emailed or filed
 * still says whose books it is and what it covers.
 *
 * jsPDF and its table plugin are ~400 kB, so they are pulled in by dynamic
 * import inside the click handler. Nobody who never presses the button pays for
 * them, and the report itself keeps rendering at the same speed it always did.
 *
 * The row model is deliberately the CSV's: a flat array of cell arrays, header
 * row included. Reports already build that once for the CSV, and a second,
 * PDF-only shape would be a second thing to keep in step with the table. What
 * the CSV encodes structurally, this file reads back structurally:
 *
 *   - the header row is the first full-width row with no numeric cells
 *   - rows before it are the report's summary lines, and go under the masthead
 *   - a one-cell row inside the table is a section heading (or, if long, a note)
 *   - a column whose every filled cell is a number is right-aligned
 */
import { type CsvRow, groupDigits, isNumericCell } from './report-export';

export interface ReportPdfInput {
  /** Stem from reportFilename(); the .pdf suffix is added for you. */
  filename: string;
  /** Company name, then its address and contact lines. */
  masthead: { name: string; lines: string[] };
  /** Already-translated report name. */
  title: string;
  /** Period or as-of line under the title. */
  subtitle?: string | undefined;
  /** Basis, or any other one-line qualifier. */
  qualifier?: string | undefined;
  /** Already-composed "Label: value" context lines. */
  context?: string[] | undefined;
  /** Footer left, e.g. "Generated August 25, 2026". */
  generated: string;
  /** Footer right. Called once per page, after the page count is known. */
  pageLabel: (page: number, pages: number) => string;
  /** Masthead line for pages 2+, e.g. "Profit & Loss (continued)". */
  continued: string;
  /** The report, exactly as the CSV writes it. */
  rows: CsvRow[];
}

const MARGIN = 40;
/** Past this many columns a portrait page squeezes the money out of shape. */
const LANDSCAPE_FROM = 7;
/** A one-cell row longer than this is prose, not a section heading. */
const NOTE_LENGTH = 90;

const INK: [number, number, number] = [15, 23, 42];
const MUTED: [number, number, number] = [100, 116, 139];
const RULE: [number, number, number] = [203, 213, 225];
const BAND: [number, number, number] = [241, 245, 249];

type Cell = { content: string; colSpan?: number; styles?: Record<string, unknown> };

export async function downloadReportPdf(input: ReportPdfInput): Promise<void> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const width = Math.max(1, ...input.rows.map((r) => r.length));
  const doc = new jsPDF({
    orientation: width >= LANDSCAPE_FROM ? 'landscape' : 'portrait',
    unit: 'pt',
    format: 'letter',
  });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - MARGIN * 2;

  const { summary, head, body } = splitRows(input.rows, width);
  const numericCols = findNumericColumns(body, width);

  const centre = (text: string, top: number, size: number, bold: boolean, color = INK): number => {
    let y = top;
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(color[0], color[1], color[2]);
    for (const line of doc.splitTextToSize(text, contentWidth) as string[]) {
      doc.text(line, pageWidth / 2, y, { align: 'center' });
      y += size + 2;
    }
    return y;
  };

  // ---- masthead (page 1) -------------------------------------------------
  let y = MARGIN + 10;
  y = centre(input.masthead.name, y, 15, true);
  y += 2;
  for (const line of input.masthead.lines) y = centre(line, y, 8.5, false, MUTED);
  y += 8;
  y = centre(input.title, y, 12.5, true);
  if (input.subtitle) y = centre(input.subtitle, y, 10, false, MUTED);
  if (input.qualifier) y = centre(input.qualifier, y, 9, false, MUTED);
  for (const line of input.context ?? []) y = centre(line, y, 8.5, false, MUTED);
  for (const line of summary) y = centre(line, y, 9, false, INK);

  y += 6;
  doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, y, pageWidth - MARGIN, y);
  y += 12;

  /**
   * Pages 2+ get a two-line masthead instead of the full one. Reserving that
   * much top margin on every page — the first included, where startY puts the
   * table lower anyway — is what keeps a continued table from running up under
   * the company name.
   */
  const continuedHeight = 34;

  autoTable(doc, {
    startY: y,
    margin: { top: MARGIN + continuedHeight, left: MARGIN, right: MARGIN, bottom: MARGIN + 16 },
    theme: 'plain',
    head: head ? [headCells(head, numericCols)] : [],
    body: body.map((row, i) => bodyCells(row, width, numericCols, i === body.length - 1)),
    styles: {
      font: 'helvetica',
      fontSize: 8.5,
      cellPadding: { top: 3.5, right: 5, bottom: 3.5, left: 5 },
      textColor: INK,
      lineColor: RULE,
      overflow: 'linebreak',
    },
    headStyles: {
      fontStyle: 'bold',
      fontSize: 7.5,
      textColor: MUTED,
      lineWidth: { top: 0, right: 0, bottom: 0.75, left: 0 },
      lineColor: RULE,
    },
    showHead: 'everyPage',
    didDrawPage: (data) => {
      if (data.pageNumber === 1) return;
      const after = centre(input.masthead.name, MARGIN + 4, 10, true);
      centre(input.continued, after, 8.5, false, MUTED);
    },
  });

  // ---- footers -----------------------------------------------------------
  // Stamped afterwards: "of 4" is not knowable while page 1 is being drawn.
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    doc.text(input.generated, MARGIN, pageHeight - MARGIN + 12);
    doc.text(input.pageLabel(page, pages), pageWidth - MARGIN, pageHeight - MARGIN + 12, {
      align: 'right',
    });
  }

  doc.save(input.filename.endsWith('.pdf') ? input.filename : `${input.filename}.pdf`);
}

/**
 * Splits the flat rows into the summary lines that belong under the masthead,
 * the column header, and the table body.
 *
 * The header is the first full-width row with nothing numeric in it. Reports
 * that open with tiles ("Collected", "Remitted") put those before it as short
 * label/value rows, and those read far better as header lines than as a
 * headerless stub table stacked above the real one.
 */
function splitRows(
  rows: CsvRow[],
  width: number,
): { summary: string[]; head: CsvRow | null; body: CsvRow[] } {
  const headIndex =
    width >= 2
      ? rows.findIndex(
          (r) => r.length === width && r.every((c) => String(c ?? '') !== '' && !isNumericCell(c)),
        )
      : -1;

  if (headIndex < 0) return { summary: [], head: null, body: rows };

  const summary: string[] = [];
  for (const row of rows.slice(0, headIndex)) {
    const cells = row.map((c) => String(c ?? '')).filter((c) => c !== '');
    if (cells.length === 0) continue;
    const [label = '', ...rest] = cells;
    summary.push(rest.length ? `${label}: ${rest.map(groupDigits).join('  ')}` : label);
  }
  return { summary, head: rows[headIndex] ?? null, body: rows.slice(headIndex + 1) };
}

/** A column is numeric only if every filled cell in it is a number. */
function findNumericColumns(body: CsvRow[], width: number): Set<number> {
  const numeric = new Set<number>();
  for (let col = 0; col < width; col += 1) {
    let sawNumber = false;
    let sawText = false;
    for (const row of body) {
      // Short rows are section headings and notes; they get a vote on nothing.
      if (row.length !== width) continue;
      const value = row[col];
      if (String(value ?? '') === '') continue;
      if (isNumericCell(value)) sawNumber = true;
      else sawText = true;
    }
    if (sawNumber && !sawText) numeric.add(col);
  }
  return numeric;
}

function headCells(head: CsvRow, numericCols: Set<number>): Cell[] {
  return head.map((c, i) => ({
    content: String(c ?? ''),
    styles: { halign: numericCols.has(i) ? 'right' : 'left' },
  }));
}

function bodyCells(row: CsvRow, width: number, numericCols: Set<number>, isLast: boolean): Cell[] {
  if (row.length === 0) {
    return [{ content: '', colSpan: width, styles: { minCellHeight: 6 } }];
  }

  if (row.length === 1) {
    const text = String(row[0] ?? '');
    // A long single cell is a caveat the report has to carry — a truncation
    // note, a cash-basis exclusion. Setting it in italics keeps it from reading
    // as one more section of the statement.
    const isNote = text.length > NOTE_LENGTH;
    return [
      {
        content: text,
        colSpan: width,
        styles: isNote
          ? { fontStyle: 'italic', fontSize: 7.5, textColor: MUTED }
          : { fontStyle: 'bold', fillColor: BAND, textColor: INK },
      },
    ];
  }

  const total = isLast || isTotalRow(row);
  const padded: CsvRow = [...row, ...Array<string>(Math.max(0, width - row.length)).fill('')];
  return padded.map((c, i) => {
    const raw = String(c ?? '');
    const numeric = numericCols.has(i);
    return {
      content: numeric ? groupDigits(raw) : raw,
      styles: {
        halign: numeric ? 'right' : 'left',
        ...(total
          ? {
              fontStyle: 'bold',
              lineWidth: { top: 0.75, right: 0, bottom: 0, left: 0 },
              lineColor: RULE,
            }
          : {}),
      },
    };
  });
}

/**
 * A subtotal line, as every statement in the app writes one: an empty leading
 * column, then a label, then the figure. Detected by shape rather than by
 * matching label text — the labels are translated, and "Total revenue" is
 * "Ingresos totales" one language over.
 */
function isTotalRow(row: CsvRow): boolean {
  if (String(row[0] ?? '') !== '') return false;
  return row.slice(1).some((c) => String(c ?? '') !== '');
}
