import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * forms/sales-doc.ts -- shared PDF renderer for invoices and estimates.
 *
 * Both documents share 90% of the layout: company header, customer block,
 * line-item table, subtotal/tax/total, memo. The differences are localized:
 *
 *   INVOICE:
 *     - Header word "INVOICE"
 *     - Invoice date + Due date
 *     - "Balance due" line in totals (== total when status='open')
 *     - Status badge: open / partial / paid / void
 *
 *   ESTIMATE:
 *     - Header word "ESTIMATE"
 *     - Estimate date + Expiration date
 *     - No balance line (estimates don't post)
 *     - Status badge: draft / sent / accepted / declined / expired / converted
 *
 * The renderer takes a discriminated union and switches on `kind`.
 */

export interface SalesDocAddress {
  street1?: string | undefined;
  street2?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  postalCode?: string | undefined;
}

export interface SalesDocPayer {
  name: string;
  legalName?: string | null | undefined;
  ein?: string | null | undefined;
  address: SalesDocAddress;
  phone?: string | null | undefined;
  email?: string | null | undefined;
}

export interface SalesDocCustomer {
  name: string;
  companyName?: string | null | undefined;
  email?: string | null | undefined;
  address: SalesDocAddress;
  accountNumber?: string | null | undefined;
}

export interface SalesDocLine {
  lineNumber: number;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxable: boolean;
}

export type InvoiceStatus = 'open' | 'partial' | 'paid' | 'void';
export type EstimateStatus =
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'converted';

export interface InvoiceData {
  kind: 'invoice';
  payer: SalesDocPayer;
  customer: SalesDocCustomer;
  documentNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  termsDays: number | null;
  status: InvoiceStatus;
  memo?: string | null | undefined;
  lines: SalesDocLine[];
  subtotal: string;
  taxRateLabel?: string | null | undefined;
  taxAmount: string;
  total: string;
  balanceDue: string;
}

export interface EstimateData {
  kind: 'estimate';
  payer: SalesDocPayer;
  customer: SalesDocCustomer;
  documentNumber: string;
  estimateDate: string;
  expirationDate: string | null;
  termsDays: number | null;
  status: EstimateStatus;
  memo?: string | null | undefined;
  lines: SalesDocLine[];
  subtotal: string;
  taxRateLabel?: string | null | undefined;
  taxAmount: string;
  total: string;
  /** When status='converted', the resulting invoice number (informational footer line). */
  convertedInvoiceNumber?: string | null | undefined;
}

export type SalesDocData = InvoiceData | EstimateData;

function formatUsd(s: string | undefined): string {
  if (!s) return '$0.00';
  const n = Number(s);
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function addressLines(addr: SalesDocAddress): string[] {
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

const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  open: 'OPEN',
  partial: 'PARTIAL',
  paid: 'PAID',
  void: 'VOID',
};

const ESTIMATE_STATUS_LABEL: Record<EstimateStatus, string> = {
  draft: 'DRAFT',
  sent: 'SENT',
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  expired: 'EXPIRED',
  converted: 'CONVERTED',
};

export async function renderSalesDoc(data: SalesDocData): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvOblique = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const black = rgb(0, 0, 0);
  const muted = rgb(0.4, 0.4, 0.4);
  const accent = rgb(0.07, 0.43, 0.31);
  const danger = rgb(0.7, 0.13, 0.13);

  const W = 612;
  const H = 792;
  const margin = 36;
  const right = W - margin;

  const cols = {
    line: margin + 6,
    desc: margin + 40,
    qty: right - 220,
    rate: right - 150,
    tax: right - 80,
    amount: right - 60,
  };

  const ROW_HEIGHT = 16;
  const HEADER_HEIGHT = 22;
  const PAGE_BOTTOM = margin + 130; // reserve bottom for totals + memo

  const isInvoice = data.kind === 'invoice';
  const docLabel = isInvoice ? 'INVOICE' : 'ESTIMATE';
  const docDate = isInvoice ? data.invoiceDate : data.estimateDate;
  const docDueLabel = isInvoice ? 'Due date' : 'Expires';
  const docDueDate = isInvoice ? data.dueDate : data.expirationDate;
  const statusLabel = isInvoice
    ? INVOICE_STATUS_LABEL[data.status]
    : ESTIMATE_STATUS_LABEL[data.status];
  const statusColor =
    isInvoice && data.status === 'paid'
      ? accent
      : isInvoice && data.status === 'void'
        ? danger
        : !isInvoice && data.status === 'accepted'
          ? accent
          : !isInvoice && data.status === 'declined'
            ? danger
            : muted;

  // ─── Pagination of lines across pages ────────────────────────────────
  const capFirst = Math.floor((H - margin - 250 - HEADER_HEIGHT - PAGE_BOTTOM) / ROW_HEIGHT);
  const capRest = Math.floor((H - margin - 60 - HEADER_HEIGHT - PAGE_BOTTOM) / ROW_HEIGHT);
  const pageRanges: Array<{ start: number; end: number }> = [];
  if (data.lines.length === 0) {
    pageRanges.push({ start: 0, end: 0 });
  } else {
    let i = 0;
    while (i < data.lines.length) {
      const cap = pageRanges.length === 0 ? capFirst : capRest;
      pageRanges.push({ start: i, end: Math.min(i + cap, data.lines.length) });
      i += cap;
    }
  }

  pageRanges.forEach((range, pageIndex) => {
    const isLast = pageIndex === pageRanges.length - 1;
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
    const rect = (
      x: number,
      y: number,
      w: number,
      h: number,
      fill?: ReturnType<typeof rgb>,
    ) => {
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

    // ─── Page header (every page) ──────────────────────────────────────
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

    draw(docLabel, right - 110, H - margin, { size: 22, bold: true });
    draw(`#${data.documentNumber}`, right - 110, H - margin - 22, {
      size: 11,
      bold: true,
      color: muted,
    });
    if (pageRanges.length > 1) {
      draw(`Page ${pageIndex + 1} of ${pageRanges.length}`, right - 90, H - margin - 36, {
        size: 7,
        color: muted,
      });
    }

    if (pageIndex === 0) {
      // ─── Customer + meta cards ──────────────────────────────────────
      const billY = H - margin - 80;
      draw('BILL TO', margin, billY, { size: 7, color: muted });
      draw(data.customer.name, margin, billY - 14, { size: 12, bold: true });
      let cy = billY - 28;
      if (data.customer.companyName) {
        draw(data.customer.companyName, margin, cy, { size: 9 });
        cy -= 11;
      }
      for (const line of addressLines(data.customer.address)) {
        draw(line, margin, cy, { size: 9, color: muted });
        cy -= 11;
      }
      if (data.customer.email) {
        draw(data.customer.email, margin, cy, { size: 9, color: muted });
      }

      // Right-side meta card (date/due/status)
      const metaY = billY;
      const metaX = right - 220;
      const metaW = 220;
      const metaH = 80;
      rect(metaX, metaY - metaH, metaW, metaH, rgb(0.97, 0.97, 0.97));
      draw('DATE', metaX + 8, metaY - 12, { size: 7, color: muted });
      draw(docDate, metaX + 8, metaY - 24, { size: 10, bold: true });
      if (docDueDate) {
        draw(docDueLabel.toUpperCase(), metaX + 110, metaY - 12, { size: 7, color: muted });
        draw(docDueDate, metaX + 110, metaY - 24, { size: 10, bold: true });
      } else if (data.termsDays !== null && data.termsDays !== undefined) {
        draw(docDueLabel.toUpperCase(), metaX + 110, metaY - 12, { size: 7, color: muted });
        draw(`Net ${data.termsDays}`, metaX + 110, metaY - 24, { size: 10, bold: true });
      }
      draw('STATUS', metaX + 8, metaY - 44, { size: 7, color: muted });
      draw(statusLabel, metaX + 8, metaY - 58, { size: 12, bold: true, color: statusColor });
      if (isInvoice) {
        draw('BALANCE DUE', metaX + 110, metaY - 44, { size: 7, color: muted });
        draw(formatUsd(data.balanceDue), metaX + 110, metaY - 58, {
          size: 12,
          bold: true,
          color: Number(data.balanceDue) > 0 ? danger : accent,
        });
      } else if (
        !isInvoice &&
        data.status === 'converted' &&
        data.convertedInvoiceNumber
      ) {
        draw('CONVERTED TO', metaX + 110, metaY - 44, { size: 7, color: muted });
        draw(`#${data.convertedInvoiceNumber}`, metaX + 110, metaY - 58, {
          size: 11,
          bold: true,
          color: muted,
        });
      }
    }

    // ─── Lines table header ─────────────────────────────────────────
    const tableTop = pageIndex === 0 ? H - margin - 200 : H - margin - 60;
    rect(margin, tableTop - HEADER_HEIGHT, W - 2 * margin, HEADER_HEIGHT, rgb(0.93, 0.93, 0.93));
    draw('#', cols.line, tableTop - 14, { size: 7, color: muted });
    draw('Description', cols.desc, tableTop - 14, { size: 7, color: muted });
    draw('Qty', cols.qty, tableTop - 14, { size: 7, color: muted });
    draw('Rate', cols.rate, tableTop - 14, { size: 7, color: muted });
    draw('Tax', cols.tax, tableTop - 14, { size: 7, color: muted });
    draw('Amount', cols.amount, tableTop - 14, { size: 7, color: muted });

    let y = tableTop - HEADER_HEIGHT - 12;
    const slice = data.lines.slice(range.start, range.end);
    if (slice.length === 0) {
      draw('No line items.', cols.desc, y, { size: 9, italic: true, color: muted });
      y -= ROW_HEIGHT;
    } else {
      for (const ln of slice) {
        draw(String(ln.lineNumber), cols.line, y, { size: 9, color: muted });
        draw(ln.description.slice(0, 60), cols.desc, y, {
          size: 9,
          maxWidth: cols.qty - cols.desc - 6,
        });
        draw(formatQty(ln.quantity), cols.qty, y, { size: 9 });
        draw(formatUsd(ln.unitPrice), cols.rate, y, { size: 9 });
        // Helvetica is ISO-Latin-1 only -- avoid the unicode check mark.
        draw(ln.taxable ? 'Y' : '', cols.tax + 4, y, { size: 9, color: muted });
        draw(formatUsd(ln.amount), cols.amount, y, { size: 9 });
        y -= ROW_HEIGHT;
      }
    }

    if (isLast) {
      // ─── Totals ─────────────────────────────────────────────────────
      const totalsX = right - 240;
      const totalsW = 240;
      let ty = margin + 110;
      const drawTotalRow = (
        label: string,
        val: string,
        opts?: { bold?: boolean; color?: ReturnType<typeof rgb> },
      ) => {
        const labelOpts: Parameters<typeof draw>[3] = { size: 9, color: opts?.color ?? muted };
        if (opts?.bold) labelOpts.bold = true;
        const valOpts: Parameters<typeof draw>[3] = { size: 9 };
        if (opts?.bold) valOpts.bold = true;
        if (opts?.color) valOpts.color = opts.color;
        draw(label, totalsX, ty, labelOpts);
        draw(formatUsd(val), totalsX + 160, ty, valOpts);
        ty -= 14;
      };
      // Build top-down: subtotal -> tax -> total -> balance, then reverse so we can drawTotalRow downward.
      // Simpler: just draw from a fixed top.
      ty = margin + 110;
      drawTotalRow('Subtotal', data.subtotal);
      if (Number(data.taxAmount) > 0) {
        drawTotalRow(data.taxRateLabel ? `Tax (${data.taxRateLabel})` : 'Tax', data.taxAmount);
      }
      drawTotalRow('Total', data.total, { bold: true });
      if (isInvoice) {
        drawTotalRow('Balance due', data.balanceDue, {
          bold: true,
          color: Number(data.balanceDue) > 0 ? danger : accent,
        });
      }

      // ─── Memo ───────────────────────────────────────────────────────
      if (data.memo) {
        draw('Memo', margin, margin + 90, { size: 7, color: muted });
        draw(data.memo, margin, margin + 76, {
          size: 9,
          italic: true,
          maxWidth: totalsX - margin - 12,
        });
      }

      // ─── Footer ─────────────────────────────────────────────────────
      const footerLine = isInvoice
        ? Number(data.balanceDue) > 0
          ? 'Please remit payment to the address above. Thank you for your business.'
          : 'Paid in full. Thank you for your business.'
        : 'Quote is valid until the expiration date above. Thanks for the opportunity!';
      draw(footerLine, margin, margin + 24, {
        size: 8,
        italic: true,
        color: muted,
        maxWidth: W - 2 * margin,
      });
      draw(
        `${docLabel} #${data.documentNumber} · ${docDate} · Generated by KPBooks`,
        margin,
        margin,
        { size: 7, color: muted },
      );
    }
  });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

function formatQty(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  // Strip trailing zeros after the decimal for clean display.
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}
