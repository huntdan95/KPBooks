import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * forms/customer-statement.ts -- printable A/R statement of account.
 *
 * Sent monthly (or on demand) to a customer for collections. Shows opening
 * balance at period start, every charge / payment / credit during the
 * period, the closing balance at period end, and an aging snapshot of the
 * remaining balance broken into the standard QB buckets.
 *
 * Multi-page friendly: when the activity table fills the first page, we
 * spill onto fresh pages with the same column layout. Aging + totals stay
 * on the LAST page so the customer sees them last.
 */

export interface StmtAddress {
  street1?: string | undefined;
  street2?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  postalCode?: string | undefined;
}

export interface StmtPayer {
  name: string;
  legalName?: string | null | undefined;
  address: StmtAddress;
  phone?: string | null | undefined;
  email?: string | null | undefined;
}

export interface StmtCustomer {
  name: string;
  companyName?: string | null | undefined;
  accountNumber?: string | null | undefined;
  address: StmtAddress;
}

export type StmtRowType = 'invoice' | 'payment' | 'credit' | 'opening';

export interface StmtRow {
  date: string; // YYYY-MM-DD
  type: StmtRowType;
  reference: string; // e.g. "INV-1042" or "Check #1234"
  description: string;
  /** Decimal string. Charges (invoices) go in this column; positive = increases balance. */
  charge: string;
  /** Decimal string. Credits/payments go in this column; positive = decreases balance. */
  paymentAmount: string;
  /** Running balance after this row. */
  runningBalance: string;
}

export interface StmtAging {
  current: string;
  days1to30: string;
  days31to60: string;
  days61to90: string;
  days91plus: string;
  total: string;
}

export interface CustomerStatementData {
  payer: StmtPayer;
  customer: StmtCustomer;
  /** Inclusive period start. YYYY-MM-DD. */
  periodStart: string;
  /** Inclusive period end. YYYY-MM-DD. */
  periodEnd: string;
  /** Statement-issue date, often = periodEnd. */
  asOf: string;
  openingBalance: string;
  closingBalance: string;
  rows: StmtRow[];
  aging: StmtAging;
  /** Optional message, e.g. "Please remit by the 15th of the month". */
  footerMessage?: string | undefined;
}

function formatUsd(s: string | undefined): string {
  if (!s || s === '0' || s === '0.0000') return '';
  const n = Number(s);
  if (!Number.isFinite(n) || n === 0) return '';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatBalance(s: string | undefined): string {
  if (!s) return '$0.00';
  const n = Number(s);
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function addressLines(addr: StmtAddress): string[] {
  const lines: string[] = [];
  if (addr.street1) lines.push(addr.street1);
  if (addr.street2) lines.push(addr.street2);
  const cityLine = [addr.city, addr.state, addr.postalCode]
    .filter(Boolean)
    .join(', ')
    .trim();
  if (cityLine) lines.push(cityLine);
  return lines;
}

const ROW_TYPE_LABEL: Record<StmtRowType, string> = {
  opening: 'Balance forward',
  invoice: 'Invoice',
  payment: 'Payment',
  credit: 'Credit',
};

export async function renderCustomerStatement(
  data: CustomerStatementData,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvOblique = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const black = rgb(0, 0, 0);
  const muted = rgb(0.4, 0.4, 0.4);
  const accent = rgb(0.07, 0.43, 0.31);

  const W = 612;
  const H = 792;
  const margin = 36;
  const right = W - margin;

  // Column geometry for the activity table.
  const cols = {
    date: margin + 6,
    type: margin + 80,
    ref: margin + 150,
    desc: margin + 230,
    charge: right - 200,
    payment: right - 130,
    balance: right - 60,
  };
  const ROW_HEIGHT = 14;
  const HEADER_HEIGHT = 22;
  const PAGE_BOTTOM = margin + 80; // reserve room for aging + footer on last page

  function newPage(pageIndex: number, pageCount?: number) {
    const page = pdf.addPage([W, H]);

    const draw = (
      text: string,
      x: number,
      y: number,
      opts: {
        size?: number;
        bold?: boolean;
        italic?: boolean;
        color?: ReturnType<typeof rgb>;
        maxWidth?: number;
      } = {},
    ) => {
      const size = opts.size ?? 9;
      const font = opts.bold ? helvBold : opts.italic ? helvOblique : helv;
      page.drawText(text, {
        x,
        y,
        size,
        font,
        color: opts.color ?? black,
        ...(opts.maxWidth ? { maxWidth: opts.maxWidth } : {}),
      });
    };
    const rect = (x: number, y: number, w: number, h: number, fill?: ReturnType<typeof rgb>) => {
      page.drawRectangle({
        x,
        y,
        width: w,
        height: h,
        borderColor: black,
        borderWidth: 0.4,
        ...(fill ? { color: fill } : {}),
      });
    };

    // ─── Header (every page) ──────────────────────────────────────────
    draw(data.payer.legalName || data.payer.name, margin, H - margin, {
      size: 13,
      bold: true,
    });
    let py = H - margin - 14;
    for (const line of addressLines(data.payer.address)) {
      draw(line, margin, py, { size: 9, color: muted });
      py -= 11;
    }
    if (data.payer.phone) {
      draw(`Phone: ${data.payer.phone}`, margin, py, { size: 9, color: muted });
      py -= 11;
    }
    if (data.payer.email) {
      draw(data.payer.email, margin, py, { size: 9, color: muted });
    }

    draw('STATEMENT', right - 90, H - margin, { size: 18, bold: true });
    draw(`Statement of Account`, right - 130, H - margin - 18, { size: 9, color: muted });
    draw(`As of ${data.asOf}`, right - 80, H - margin - 30, { size: 9, color: muted });
    if (pageCount && pageCount > 1) {
      draw(`Page ${pageIndex + 1} of ${pageCount}`, right - 80, H - margin - 42, {
        size: 7,
        color: muted,
      });
    }

    // Customer block (only on first page)
    if (pageIndex === 0) {
      const custY = H - margin - 90;
      draw('STATEMENT FOR', margin, custY, { size: 7, color: muted });
      draw(data.customer.name, margin, custY - 14, { size: 12, bold: true });
      let cy = custY - 28;
      if (data.customer.companyName) {
        draw(data.customer.companyName, margin, cy, { size: 9 });
        cy -= 11;
      }
      for (const line of addressLines(data.customer.address)) {
        draw(line, margin, cy, { size: 9, color: muted });
        cy -= 11;
      }
      if (data.customer.accountNumber) {
        draw(`Account #${data.customer.accountNumber}`, margin, cy, { size: 8, color: muted });
      }

      // Period summary card on the right
      const cardY = custY;
      const cardX = right - 220;
      const cardW = 220;
      const cardH = 80;
      rect(cardX, cardY - cardH, cardW, cardH, rgb(0.97, 0.97, 0.97));
      draw('STATEMENT PERIOD', cardX + 8, cardY - 12, { size: 7, color: muted });
      draw(
        `${data.periodStart}  to  ${data.periodEnd}`,
        cardX + 8,
        cardY - 26,
        { size: 10, bold: true },
      );
      draw('OPENING BALANCE', cardX + 8, cardY - 44, { size: 7, color: muted });
      draw(formatBalance(data.openingBalance), cardX + 8, cardY - 56, { size: 10 });
      draw('CLOSING BALANCE', cardX + 110, cardY - 44, { size: 7, color: muted });
      draw(formatBalance(data.closingBalance), cardX + 110, cardY - 56, {
        size: 11,
        bold: true,
        color: accent,
      });
    }

    // ─── Activity table header ────────────────────────────────────────
    const tableTop = pageIndex === 0 ? H - margin - 200 : H - margin - 60;
    rect(margin, tableTop - HEADER_HEIGHT, W - 2 * margin, HEADER_HEIGHT, rgb(0.93, 0.93, 0.93));
    draw('ACTIVITY', margin + 6, tableTop - 14, { size: 8, bold: true, color: muted });
    draw('Date', cols.date, tableTop - 14, { size: 7, color: muted });
    draw('Type', cols.type, tableTop - 14, { size: 7, color: muted });
    draw('Reference', cols.ref, tableTop - 14, { size: 7, color: muted });
    draw('Description', cols.desc, tableTop - 14, { size: 7, color: muted });
    draw('Charge', cols.charge, tableTop - 14, { size: 7, color: muted });
    draw('Payment', cols.payment, tableTop - 14, { size: 7, color: muted });
    draw('Balance', cols.balance, tableTop - 14, { size: 7, color: muted });

    return { draw, rect, tableTop };
  }

  // ─── Pagination of rows across pages ────────────────────────────────
  const pages: Array<{ start: number; end: number }> = [];
  // First-page row capacity is smaller (header + customer block above it).
  const capFirst = Math.floor((H - margin - 200 - HEADER_HEIGHT - PAGE_BOTTOM) / ROW_HEIGHT);
  const capRest = Math.floor((H - margin - 60 - HEADER_HEIGHT - PAGE_BOTTOM) / ROW_HEIGHT);

  if (data.rows.length === 0) {
    pages.push({ start: 0, end: 0 });
  } else {
    let i = 0;
    while (i < data.rows.length) {
      const cap = pages.length === 0 ? capFirst : capRest;
      pages.push({ start: i, end: Math.min(i + cap, data.rows.length) });
      i += cap;
    }
  }

  // Render each page.
  pages.forEach((p, idx) => {
    const isLast = idx === pages.length - 1;
    const { draw, rect, tableTop } = newPage(idx, pages.length);

    const slice = data.rows.slice(p.start, p.end);
    let y = tableTop - HEADER_HEIGHT - 12;

    if (slice.length === 0) {
      draw('No activity in this period.', cols.date, y, { size: 9, italic: true, color: muted });
      y -= ROW_HEIGHT;
    } else {
      for (const r of slice) {
        draw(r.date, cols.date, y, { size: 9 });
        draw(ROW_TYPE_LABEL[r.type] ?? r.type, cols.type, y, { size: 9, color: muted });
        draw(r.reference.slice(0, 18), cols.ref, y, { size: 9 });
        draw(r.description.slice(0, 45), cols.desc, y, { size: 9, maxWidth: cols.charge - cols.desc - 6 });
        draw(formatUsd(r.charge), cols.charge, y, { size: 9 });
        draw(formatUsd(r.paymentAmount), cols.payment, y, { size: 9 });
        draw(formatBalance(r.runningBalance), cols.balance, y, { size: 9 });
        y -= ROW_HEIGHT;
      }
    }

    if (isLast) {
      // ─── Aging snapshot on the bottom of the last page ────────────
      const agingY = margin + 100;
      const agingX = margin;
      const agingW = W - 2 * margin;

      rect(agingX, agingY - 60, agingW, 60);
      draw('AGING SNAPSHOT (as of ' + data.asOf + ')', agingX + 6, agingY - 12, {
        size: 8,
        bold: true,
        color: muted,
      });
      const cellW = agingW / 6;
      const buckets: Array<{ label: string; v: string }> = [
        { label: 'Current', v: data.aging.current },
        { label: '1 - 30', v: data.aging.days1to30 },
        { label: '31 - 60', v: data.aging.days31to60 },
        { label: '61 - 90', v: data.aging.days61to90 },
        { label: 'Over 90', v: data.aging.days91plus },
        { label: 'Total due', v: data.aging.total },
      ];
      buckets.forEach((b, i) => {
        const cx = agingX + i * cellW;
        draw(b.label, cx + 6, agingY - 28, { size: 7, color: muted });
        const isTotal = i === buckets.length - 1;
        draw(formatBalance(b.v), cx + 6, agingY - 44, {
          size: isTotal ? 11 : 10,
          bold: isTotal,
          color: isTotal ? accent : black,
        });
      });

      // ─── Closing total row ────────────────────────────────────────
      draw('AMOUNT DUE NOW', agingX, agingY + 8, { size: 9, bold: true, color: muted });
      draw(formatBalance(data.closingBalance), agingX + 130, agingY + 8, {
        size: 13,
        bold: true,
        color: accent,
      });

      // ─── Footer message ──────────────────────────────────────────
      if (data.footerMessage) {
        draw(data.footerMessage, margin, margin + 24, {
          size: 8,
          italic: true,
          color: muted,
          maxWidth: W - 2 * margin,
        });
      }
      draw(
        `Statement of Account · ${data.payer.name} · ${data.asOf}`,
        margin,
        margin,
        { size: 7, color: muted },
      );
      draw('Please remit to address above.', right - 160, margin, {
        size: 7,
        italic: true,
        color: muted,
      });
    }
  });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
