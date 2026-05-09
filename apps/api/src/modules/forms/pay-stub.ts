import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * forms/pay-stub.ts -- printable pay-stub for a single payment to a worker.
 *
 * Per the office workflow this app is built for, all worker payroll is paid
 * via printed check (no ACH). This stub accompanies the physical check so
 * the contractor / employee has a record of what they were paid for.
 *
 * For 1099 contractors (the common case here) there are no withholdings --
 * the contractor is responsible for their own taxes. Gross pay equals net
 * pay. Optional informational withholdings can still be passed in for W-2
 * employees if the user wants to type them in at print time, but the form
 * does NOT compute taxes. KPBooks is not a payroll engine.
 */

export interface PayStubAddress {
  street1?: string | undefined;
  street2?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  postalCode?: string | undefined;
}

export interface PayStubPayer {
  name: string;
  legalName?: string | null | undefined;
  ein?: string | null | undefined;
  address: PayStubAddress;
  phone?: string | null | undefined;
}

export interface PayStubRecipient {
  name: string;
  taxId?: string | null | undefined;
  address: PayStubAddress;
  workerType?: 'contractor' | 'employee' | null | undefined;
}

export interface PayStubLine {
  /** Optional date the work happened. Falls back to "—" when omitted. */
  entryDate?: string | undefined;
  description: string;
  /** Decimal hours. Omit for fixed-fee or per-project lines. */
  hours?: string | undefined;
  /** Hourly rate. Omit if hours is omitted. */
  rate?: string | undefined;
  /** Line amount. Always required. */
  amount: string;
}

export interface PayStubDeduction {
  label: string;
  /** Decimal string. */
  current: string;
  /** Optional YTD value. */
  ytd?: string | undefined;
}

export interface PayStubData {
  payer: PayStubPayer;
  recipient: PayStubRecipient;
  payDate: string; // YYYY-MM-DD
  /** Period start (optional). YYYY-MM-DD. */
  periodStart?: string | undefined;
  /** Period end (optional). YYYY-MM-DD. */
  periodEnd?: string | undefined;
  /** Check number / payment reference. */
  checkNumber?: string | null | undefined;
  /** Payment method: check / cash / eft / credit_card / other. */
  paymentMethod?: string | undefined;
  memo?: string | null | undefined;
  /** Earnings detail. If empty, falls back to a single "Services rendered" line. */
  lines: PayStubLine[];
  /** Current-period gross. Decimal string. */
  grossCurrent: string;
  /** YTD gross. Decimal string. */
  grossYtd: string;
  /** Optional deductions (display only -- not computed). */
  deductions?: PayStubDeduction[] | undefined;
  /** Net pay current. Defaults to grossCurrent - sum(deductions.current). */
  netCurrent?: string | undefined;
  /** Net pay YTD. */
  netYtd?: string | undefined;
}

function formatUsd(s: string | undefined): string {
  if (!s) return '$0.00';
  const n = Number(s);
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatHoursStr(s: string | undefined): string {
  if (!s) return '';
  const n = Number(s);
  if (!Number.isFinite(n)) return '';
  return n
    .toFixed(2)
    .replace(/\.00$/, '')
    .replace(/0$/, '');
}

function addressLines(addr: PayStubAddress): string[] {
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

function sumDeductions(ds: PayStubDeduction[] | undefined, key: 'current' | 'ytd'): number {
  if (!ds) return 0;
  return ds.reduce((acc, d) => {
    const v = key === 'current' ? d.current : d.ytd;
    const n = Number(v ?? 0);
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);
}

export async function renderPayStub(data: PayStubData): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvOblique = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const black = rgb(0, 0, 0);
  const muted = rgb(0.4, 0.4, 0.4);
  const accent = rgb(0.07, 0.43, 0.31); // emerald-700-ish, used for net pay

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
      borderWidth: 0.6,
      ...(fill ? { color: fill } : {}),
    });
  };

  const W = 612;
  const margin = 36;
  const right = W - margin;
  const top = 792 - margin;

  // ─── Header: company + "PAY STUB" ──────────────────────────────────────
  draw(data.payer.legalName || data.payer.name, margin, top, { size: 14, bold: true });
  let py = top - 14;
  for (const line of addressLines(data.payer.address)) {
    draw(line, margin, py, { size: 9, color: muted });
    py -= 11;
  }
  if (data.payer.phone) {
    draw(`Phone: ${data.payer.phone}`, margin, py, { size: 9, color: muted });
    py -= 11;
  }
  if (data.payer.ein) {
    draw(`EIN: ${data.payer.ein}`, margin, py, { size: 8, color: muted });
  }

  draw('PAY STUB', right - 90, top, { size: 18, bold: true });
  draw('Statement of Earnings', right - 130, top - 18, { size: 9, color: muted });

  // ─── Pay info row ──────────────────────────────────────────────────────
  const payInfoY = top - 90;
  rect(margin, payInfoY - 36, W - 2 * margin, 36, rgb(0.97, 0.97, 0.97));
  const cellW = (W - 2 * margin) / 4;
  draw('PAY DATE', margin + 6, payInfoY - 12, { size: 7, color: muted });
  draw(data.payDate, margin + 6, payInfoY - 26, { size: 11, bold: true });

  draw('PAY PERIOD', margin + cellW + 6, payInfoY - 12, { size: 7, color: muted });
  if (data.periodStart && data.periodEnd) {
    // Use ASCII arrow -- the PDF standard Helvetica font only supports
    // ISO-Latin-1, so unicode -> would fail to encode at draw time.
    draw(
      `${data.periodStart} - ${data.periodEnd}`,
      margin + cellW + 6,
      payInfoY - 26,
      { size: 10, bold: true },
    );
  } else {
    draw('—', margin + cellW + 6, payInfoY - 26, { size: 10 });
  }

  draw('CHECK / REF', margin + 2 * cellW + 6, payInfoY - 12, { size: 7, color: muted });
  draw(data.checkNumber || '—', margin + 2 * cellW + 6, payInfoY - 26, {
    size: 11,
    bold: true,
  });

  draw('METHOD', margin + 3 * cellW + 6, payInfoY - 12, { size: 7, color: muted });
  draw(data.paymentMethod || 'check', margin + 3 * cellW + 6, payInfoY - 26, {
    size: 11,
    bold: true,
  });

  // ─── Recipient block ───────────────────────────────────────────────────
  const recipY = payInfoY - 50;
  draw('PAY TO', margin, recipY, { size: 7, color: muted });
  draw(data.recipient.name, margin, recipY - 14, { size: 12, bold: true });
  let ry = recipY - 28;
  for (const line of addressLines(data.recipient.address)) {
    draw(line, margin, ry, { size: 9, color: muted });
    ry -= 11;
  }
  if (data.recipient.taxId) {
    draw(`TIN: ${data.recipient.taxId}`, margin, ry, { size: 8, color: muted });
  }
  if (data.recipient.workerType === 'contractor') {
    draw(
      '1099 contractor — recipient is responsible for their own income tax, SE tax, and benefits.',
      margin + 220,
      recipY - 14,
      { size: 7, italic: true, color: muted, maxWidth: right - margin - 220 },
    );
  }

  // ─── Earnings table ─────────────────────────────────────────────────────
  const earningsY = recipY - 90;
  const earningsH = 22 + Math.max(1, data.lines.length) * 14 + 8;
  const cols = {
    date: margin + 6,
    desc: margin + 80,
    hours: margin + 320,
    rate: margin + 380,
    amount: right - 70,
  };
  rect(margin, earningsY - earningsH, W - 2 * margin, earningsH);
  rect(margin, earningsY - 18, W - 2 * margin, 18, rgb(0.93, 0.93, 0.93));
  draw('EARNINGS', margin + 6, earningsY - 12, { size: 8, bold: true, color: muted });
  draw('Date', cols.date, earningsY - 12, { size: 7, color: muted });
  draw('Description', cols.desc, earningsY - 12, { size: 7, color: muted });
  draw('Hrs', cols.hours, earningsY - 12, { size: 7, color: muted });
  draw('Rate', cols.rate, earningsY - 12, { size: 7, color: muted });
  draw('Amount', cols.amount, earningsY - 12, { size: 7, color: muted });

  let ey = earningsY - 32;
  if (data.lines.length === 0) {
    draw('—', cols.date, ey, { size: 9 });
    draw('Services rendered', cols.desc, ey, { size: 9 });
    draw('', cols.hours, ey, { size: 9 });
    draw('', cols.rate, ey, { size: 9 });
    draw(formatUsd(data.grossCurrent), cols.amount, ey, { size: 9 });
  } else {
    for (const l of data.lines) {
      draw(l.entryDate ?? '—', cols.date, ey, { size: 9 });
      draw(l.description.slice(0, 38), cols.desc, ey, { size: 9, maxWidth: 230 });
      draw(formatHoursStr(l.hours), cols.hours, ey, { size: 9 });
      draw(l.rate ? formatUsd(l.rate) : '', cols.rate, ey, { size: 9 });
      draw(formatUsd(l.amount), cols.amount, ey, { size: 9 });
      ey -= 14;
    }
  }

  // ─── Totals: Gross / Deductions / Net (right column) ───────────────────
  const totalsY = earningsY - earningsH - 16;
  const totalsX = right - 240;
  const totalsW = right - totalsX;
  const dedCount = data.deductions?.length ?? 0;
  const totalsH = 22 + (dedCount > 0 ? 18 + dedCount * 14 : 0) + 28 + 22;
  rect(totalsX, totalsY - totalsH, totalsW, totalsH);

  // Header row
  rect(totalsX, totalsY - 18, totalsW, 18, rgb(0.93, 0.93, 0.93));
  draw('Description', totalsX + 6, totalsY - 12, { size: 7, color: muted });
  draw('Current', totalsX + 110, totalsY - 12, { size: 7, color: muted });
  draw('YTD', totalsX + 175, totalsY - 12, { size: 7, color: muted });

  let ty = totalsY - 32;
  draw('Gross pay', totalsX + 6, ty, { size: 9, bold: true });
  draw(formatUsd(data.grossCurrent), totalsX + 110, ty, { size: 9, bold: true });
  draw(formatUsd(data.grossYtd), totalsX + 175, ty, { size: 9, bold: true });
  ty -= 14;

  if (data.deductions && data.deductions.length > 0) {
    rect(totalsX, ty - 4, totalsW, 1, muted); // subtle divider
    draw('Deductions', totalsX + 6, ty - 14, { size: 8, color: muted });
    ty -= 18;
    for (const d of data.deductions) {
      draw(d.label, totalsX + 6, ty, { size: 9 });
      draw(formatUsd(d.current), totalsX + 110, ty, { size: 9 });
      draw(formatUsd(d.ytd), totalsX + 175, ty, { size: 9 });
      ty -= 14;
    }
  }

  // Net pay row (highlighted)
  rect(totalsX, ty - 22, totalsW, 22, rgb(0.93, 0.99, 0.96));
  const netCurrent =
    data.netCurrent ??
    (Number(data.grossCurrent) - sumDeductions(data.deductions, 'current')).toFixed(4);
  const netYtd =
    data.netYtd ?? (Number(data.grossYtd) - sumDeductions(data.deductions, 'ytd')).toFixed(4);
  draw('NET PAY', totalsX + 6, ty - 14, { size: 10, bold: true, color: accent });
  draw(formatUsd(netCurrent), totalsX + 110, ty - 14, { size: 10, bold: true, color: accent });
  draw(formatUsd(netYtd), totalsX + 175, ty - 14, { size: 10, bold: true, color: accent });

  // ─── Memo ──────────────────────────────────────────────────────────────
  if (data.memo) {
    draw('MEMO', margin, totalsY - 32, { size: 7, color: muted });
    draw(data.memo, margin, totalsY - 46, {
      size: 9,
      italic: true,
      maxWidth: totalsX - margin - 12,
    });
  }

  // ─── Footer ────────────────────────────────────────────────────────────
  draw(
    `Pay stub generated by KPBooks · ${data.payDate}`,
    margin,
    margin,
    { size: 7, color: muted },
  );
  draw('This is a record of payment, not a substitute for IRS Form W-2.', right - 280, margin, {
    size: 7,
    italic: true,
    color: muted,
  });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
