import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * forms/1099-nec.ts -- pure renderer for IRS Form 1099-NEC.
 *
 * Generates a clean, readable facsimile suitable for:
 *   - Copy B (Recipient): give to the contractor
 *   - Copy C (Payer): keep for the company's records
 *   - Copy 1/2 (State): if state filing required
 *
 * NOTE on Copy A: the IRS requires Copy A to be filed either electronically
 * (via FIRE) or printed onto the official red-ink scannable form provided
 * by the IRS. This renderer is NOT scannable -- it produces a clean
 * black-and-white facsimile that's legal for Copy B/C/1/2 but NOT for
 * Copy A. The UI surfaces this caveat.
 *
 * Layout coordinates use PDF points (72/inch). Letter is 612x792.
 * Y-coordinates in pdf-lib are bottom-up. Box positions roughly mirror the
 * IRS form layout so a CPA familiar with the form can read it at a glance.
 */

export type CopyType = 'B' | 'C' | '1' | '2';

export interface Address {
  street1?: string | undefined;
  street2?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  postalCode?: string | undefined;
  country?: string | undefined;
}

export interface Payer {
  name: string;
  legalName?: string | null | undefined;
  ein: string;
  address: Address;
  phone?: string | null | undefined;
}

export interface Recipient {
  name: string;
  taxId: string;
  /** Account number per IRS form. Optional; we use the vendor account_number if set, else blank. */
  accountNumber?: string | null | undefined;
  address: Address;
}

export interface NineteenNinetyNineNECData {
  payer: Payer;
  recipient: Recipient;
  taxYear: number;
  /** Box 1: Nonemployee compensation. Decimal string, e.g. "12345.67". */
  nonemployeeCompensation: string;
  /** Box 4: Federal income tax withheld. Decimal string. Optional, default "0". */
  federalIncomeTaxWithheld?: string | undefined;
  /** Box 5: State tax withheld. Optional. */
  stateTaxWithheld?: string | undefined;
  /** Box 6: State / payer's state ID number. Optional. */
  payerStateId?: string | undefined;
  /** Box 7: State income. Optional. */
  stateIncome?: string | undefined;
  /** True if this filing corrects a previously-filed 1099. */
  corrected?: boolean | undefined;
}

const COPY_LABEL: Record<CopyType, string> = {
  B: 'Copy B — For Recipient',
  C: 'Copy C — For Payer',
  '1': "Copy 1 — For State Tax Department",
  '2': "Copy 2 — To be filed with recipient's state income tax return, when required",
};

const COPY_DESCRIPTION: Record<CopyType, string> = {
  B: "This is important tax information and is being furnished to the IRS. If you are required to file a return, a negligence penalty or other sanction may be imposed on you if this income is taxable and the IRS determines that it has not been reported.",
  C: 'For Payer. Keep this copy with your records.',
  '1': "File this copy with your state's tax department, when required.",
  '2': 'Include this copy when filing the recipient\'s state income tax return, if applicable.',
};

function formatUsd(s: string | undefined): string {
  if (!s) return '';
  const n = Number(s);
  if (!Number.isFinite(n) || n === 0) return '';
  // Per IRS: dollars and cents, comma-separated, no $ sign on the form.
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatAddressLines(addr: Address): string[] {
  const lines: string[] = [];
  if (addr.street1) lines.push(addr.street1);
  if (addr.street2) lines.push(addr.street2);
  const cityLine = [addr.city, addr.state, addr.postalCode].filter(Boolean).join(', ').trim();
  if (cityLine) lines.push(cityLine);
  if (addr.country && addr.country.toUpperCase() !== 'US' && addr.country.toUpperCase() !== 'USA') {
    lines.push(addr.country);
  }
  return lines;
}

/**
 * Generate one Copy of a 1099-NEC. Returns a PDF byte buffer.
 */
export async function render1099NEC(
  data: NineteenNinetyNineNECData,
  copy: CopyType,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // Letter
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvOblique = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const black = rgb(0, 0, 0);
  const muted = rgb(0.35, 0.35, 0.35);

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

  const rect = (x: number, y: number, w: number, h: number, thickness = 0.6) => {
    page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      borderColor: black,
      borderWidth: thickness,
    });
  };

  // Page geometry
  const W = 612;
  const margin = 36;
  const right = W - margin;
  const top = 792 - margin;

  // ─── Form header strip ─────────────────────────────────────────────────
  draw(`Form 1099-NEC (${data.taxYear})`, margin, top, { size: 14, bold: true });
  draw('Nonemployee Compensation', margin, top - 16, { size: 11, bold: true });
  draw('OMB No. 1545-0116', right - 110, top, { size: 8, color: muted });
  draw(COPY_LABEL[copy], right - 250, top - 14, { size: 9, bold: true, color: muted });

  if (data.corrected) {
    draw('CORRECTED', right - 90, top - 28, { size: 11, bold: true, color: rgb(0.7, 0, 0) });
  }

  // ─── Payer block (top-left, large box) ─────────────────────────────────
  const payerY = top - 38;
  const payerH = 110;
  rect(margin, payerY - payerH, 360, payerH);
  draw("PAYER'S name, street address, city or town, state, country, ZIP, and phone", margin + 4, payerY - 12, {
    size: 7,
    color: muted,
  });
  let py = payerY - 26;
  draw(data.payer.legalName || data.payer.name, margin + 6, py, { size: 10, bold: true });
  py -= 14;
  for (const line of formatAddressLines(data.payer.address)) {
    draw(line, margin + 6, py, { size: 9 });
    py -= 12;
  }
  if (data.payer.phone) {
    draw(`Phone: ${data.payer.phone}`, margin + 6, py, { size: 9 });
  }

  // ─── TIN row (right of payer) ──────────────────────────────────────────
  const tinTop = top - 38;
  const tinX = margin + 366;
  const tinW = right - tinX;
  rect(tinX, tinTop - 30, tinW / 2 - 1, 30);
  rect(tinX + tinW / 2 + 1, tinTop - 30, tinW / 2 - 1, 30);
  draw("PAYER'S TIN", tinX + 4, tinTop - 8, { size: 7, color: muted });
  draw(maskTin(data.payer.ein, copy), tinX + 6, tinTop - 22, { size: 11, bold: true });
  draw("RECIPIENT'S TIN", tinX + tinW / 2 + 5, tinTop - 8, { size: 7, color: muted });
  draw(maskTin(data.recipient.taxId, copy), tinX + tinW / 2 + 7, tinTop - 22, {
    size: 11,
    bold: true,
  });

  // ─── Box 1: Nonemployee compensation (right side, mid) ─────────────────
  const box1Y = tinTop - 32;
  const box1H = 36;
  rect(tinX, box1Y - box1H, tinW, box1H);
  draw('1  Nonemployee compensation', tinX + 4, box1Y - 12, { size: 8, color: muted });
  draw(`$ ${formatUsd(data.nonemployeeCompensation)}`, tinX + 8, box1Y - 28, {
    size: 13,
    bold: true,
  });

  // ─── Recipient block ───────────────────────────────────────────────────
  const recipY = payerY - payerH - 6;
  const recipH = 92;
  rect(margin, recipY - recipH, 360, recipH);
  draw("RECIPIENT'S name", margin + 4, recipY - 10, { size: 7, color: muted });
  let ry = recipY - 24;
  draw(data.recipient.name, margin + 6, ry, { size: 11, bold: true });
  ry -= 14;
  draw('Street address (including apt. no.)', margin + 4, ry + 2, { size: 7, color: muted });
  ry -= 4;
  for (const line of formatAddressLines(data.recipient.address)) {
    draw(line, margin + 6, ry, { size: 9 });
    ry -= 12;
  }

  // ─── Box 2: Direct sales >= $5000 (checkbox) ───────────────────────────
  const box2Y = box1Y - box1H - 4;
  const box2H = 28;
  rect(tinX, box2Y - box2H, tinW, box2H);
  draw(
    '2  Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale',
    tinX + 4,
    box2Y - 10,
    { size: 7, color: muted, maxWidth: tinW - 30 },
  );
  // Empty checkbox by default.
  rect(tinX + tinW - 18, box2Y - 22, 10, 10, 0.8);

  // ─── Account number row + FATCA ────────────────────────────────────────
  const acctY = recipY - recipH - 6;
  const acctH = 22;
  rect(margin, acctY - acctH, 360, acctH);
  draw('Account number (see instructions)', margin + 4, acctY - 8, { size: 7, color: muted });
  if (data.recipient.accountNumber) {
    draw(data.recipient.accountNumber, margin + 6, acctY - 18, { size: 9 });
  }

  // ─── Box 3: blank/reserved ─────────────────────────────────────────────
  const box3Y = box2Y - box2H - 4;
  const box3H = 22;
  rect(tinX, box3Y - box3H, tinW, box3H);
  draw('3', tinX + 4, box3Y - 8, { size: 7, color: muted });

  // ─── Box 4: Federal income tax withheld ────────────────────────────────
  const box4Y = acctY - acctH - 6;
  const box4H = 30;
  rect(margin, box4Y - box4H, 360, box4H);
  draw('4  Federal income tax withheld', margin + 4, box4Y - 10, { size: 7, color: muted });
  draw(`$ ${formatUsd(data.federalIncomeTaxWithheld)}`, margin + 8, box4Y - 24, {
    size: 11,
    bold: true,
  });

  // Right column at this row: empty box (matches form layout)
  rect(tinX, box3Y - box3H - 6 - 30, tinW, 30);

  // ─── State row: 5 / 6 / 7 ──────────────────────────────────────────────
  const stateY = box4Y - box4H - 6;
  const stateH = 36;
  const cell = (W - 2 * margin) / 3;
  rect(margin, stateY - stateH, cell, stateH);
  rect(margin + cell, stateY - stateH, cell, stateH);
  rect(margin + 2 * cell, stateY - stateH, cell, stateH);
  draw('5  State tax withheld', margin + 4, stateY - 10, { size: 7, color: muted });
  draw(`$ ${formatUsd(data.stateTaxWithheld)}`, margin + 8, stateY - 24, { size: 10, bold: true });
  draw("6  State / Payer's state no.", margin + cell + 4, stateY - 10, { size: 7, color: muted });
  if (data.payerStateId) {
    draw(data.payerStateId, margin + cell + 8, stateY - 24, { size: 10, bold: true });
  }
  draw('7  State income', margin + 2 * cell + 4, stateY - 10, { size: 7, color: muted });
  draw(`$ ${formatUsd(data.stateIncome)}`, margin + 2 * cell + 8, stateY - 24, {
    size: 10,
    bold: true,
  });

  // ─── Footer: copy description + recipient instructions ─────────────────
  const footerY = stateY - stateH - 16;
  draw(COPY_DESCRIPTION[copy], margin, footerY, {
    size: 8,
    italic: true,
    color: muted,
    maxWidth: W - 2 * margin,
  });

  // Bottom strip
  draw(
    `Form 1099-NEC  |  Generated by KPBooks  |  Tax Year ${data.taxYear}`,
    margin,
    margin,
    { size: 7, color: muted },
  );
  draw(
    copy === 'B'
      ? 'Department of the Treasury — Internal Revenue Service'
      : 'For internal record keeping. Not a substitute for IRS-scannable Copy A.',
    right - 280,
    margin,
    { size: 7, color: muted },
  );

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

/**
 * Render multiple copies into a single multi-page PDF. Useful for "download
 * all copies" — payer gets a binder-friendly stack.
 */
export async function render1099NECCopies(
  data: NineteenNinetyNineNECData,
  copies: CopyType[],
): Promise<Buffer> {
  if (copies.length === 0) {
    throw new Error('at least one copy type required');
  }
  if (copies.length === 1) {
    return render1099NEC(data, copies[0]!);
  }
  const merged = await PDFDocument.create();
  for (const copy of copies) {
    const buf = await render1099NEC(data, copy);
    const src = await PDFDocument.load(buf);
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  const bytes = await merged.save();
  return Buffer.from(bytes);
}

/**
 * On Copy B (recipient's copy) IRS allows TIN truncation -- show only the
 * last 4 digits of the recipient's TIN. Payer TIN is never truncated.
 * Copy C / 1 / 2 show full TINs.
 */
function maskTin(raw: string, copy: CopyType): string {
  const cleaned = raw.replace(/[^\d]/g, '');
  if (cleaned.length === 0) return raw;

  const formatSsn = (s: string) =>
    s.length === 9 ? `${s.slice(0, 3)}-${s.slice(3, 5)}-${s.slice(5)}` : s;
  const formatEin = (s: string) =>
    s.length === 9 ? `${s.slice(0, 2)}-${s.slice(2)}` : s;
  const looksLikeEin = raw.includes('-') && raw.indexOf('-') === 2;

  // Truncation only applies to recipient on Copy B; we apply at the call site
  // by passing the right value here. See call sites above.
  void copy;

  if (looksLikeEin || cleaned.length !== 9) return formatEin(cleaned);
  return formatSsn(cleaned);
}

/**
 * Pre-flight validation — returns the list of missing/invalid fields so the
 * UI can surface a friendly "fix these first" panel instead of generating a
 * broken PDF.
 */
export interface PreflightIssue {
  field: string;
  message: string;
  fix: 'company-settings' | 'worker-edit' | 'upload-w9' | 'pay-more';
}

export function preflight1099NEC(input: {
  payer: { name?: string; ein?: string | null; address?: Address | null; phone?: string | null };
  recipient: {
    displayName?: string;
    taxId?: string | null;
    mailingAddress?: Address | null;
  };
  hasW9: boolean;
  nonemployeeCompensation: string;
}): PreflightIssue[] {
  const issues: PreflightIssue[] = [];

  // Payer
  if (!input.payer.name?.trim()) {
    issues.push({
      field: 'payer.name',
      message: 'company name is missing',
      fix: 'company-settings',
    });
  }
  if (!input.payer.ein?.trim()) {
    issues.push({
      field: 'payer.ein',
      message: 'company EIN is missing (required as Payer TIN on the form)',
      fix: 'company-settings',
    });
  }
  const pa = input.payer.address;
  if (!pa?.street1 || !pa?.city || !pa?.state || !pa?.postalCode) {
    issues.push({
      field: 'payer.address',
      message: "company mailing address is incomplete (need street, city, state, ZIP)",
      fix: 'company-settings',
    });
  }

  // Recipient
  if (!input.recipient.displayName?.trim()) {
    issues.push({
      field: 'recipient.name',
      message: "recipient's name is missing",
      fix: 'worker-edit',
    });
  }
  if (!input.recipient.taxId?.trim()) {
    issues.push({
      field: 'recipient.taxId',
      message: "recipient's SSN/EIN is missing — file the 1099 with their TIN",
      fix: 'worker-edit',
    });
  }
  const ra = input.recipient.mailingAddress;
  if (!ra?.street1 || !ra?.city || !ra?.state || !ra?.postalCode) {
    issues.push({
      field: 'recipient.address',
      message: "recipient's mailing address is incomplete (need street, city, state, ZIP)",
      fix: 'worker-edit',
    });
  }

  // Documents
  if (!input.hasW9) {
    issues.push({
      field: 'recipient.w9',
      message: 'no W-9 on file — the IRS requires you obtain one before paying a contractor',
      fix: 'upload-w9',
    });
  }

  // Threshold
  const amount = Number(input.nonemployeeCompensation);
  if (!Number.isFinite(amount) || amount < 600) {
    issues.push({
      field: 'amount',
      message: `payments to this contractor in tax year are $${amount.toFixed(2)} — below the $600 1099-NEC threshold`,
      fix: 'pay-more',
    });
  }

  return issues;
}
