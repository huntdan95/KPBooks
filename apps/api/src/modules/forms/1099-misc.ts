import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Address, CopyType, Payer, Recipient } from './1099-nec.js';

/**
 * forms/1099-misc.ts -- IRS Form 1099-MISC renderer (companion to 1099-nec).
 *
 * Used for non-NEC payments: rents (Box 1), royalties (Box 2), other income
 * (Box 3), medical/health-care (Box 6), gross proceeds to attorneys (Box 10),
 * etc. Real-world vendors can land in multiple boxes (e.g., a landlord-CPA
 * who also gets attorney-fee disbursements), so the renderer accepts ALL
 * boxes optional and lays out whichever are populated.
 *
 * Same caveats as 1099-NEC: Copy A must be e-filed via FIRE or printed onto
 * the IRS-supplied red-ink scannable form. This renderer is a clean
 * black-and-white facsimile suitable for Copy B / C / 1 / 2 only.
 *
 * Box thresholds (per IRS 2024 instructions):
 *   - Box 1 (Rents)               $600
 *   - Box 2 (Royalties)           $10  -- the lowest threshold on the form
 *   - Box 3 (Other income)        $600
 *   - Box 5 (Fishing boat)        any amount
 *   - Box 6 (Medical/health care) $600
 *   - Box 8 (Substitute payments) $10
 *   - Box 10 (Attorney proceeds)  $600
 *   - Box 14 (Excess golden parachute) any
 *   - Box 15 (Nonqualified deferred)   any
 * Below-threshold filings still emit a PDF but get a preflight warning.
 */

export interface NineteenNinetyNineMISCData {
  payer: Payer;
  recipient: Recipient;
  taxYear: number;

  // Income boxes (decimal strings; empty/0 = blank on form).
  rents?: string | undefined; // Box 1
  royalties?: string | undefined; // Box 2
  otherIncome?: string | undefined; // Box 3

  // Withholding
  federalIncomeTaxWithheld?: string | undefined; // Box 4

  // More income
  fishingBoatProceeds?: string | undefined; // Box 5
  medicalPayments?: string | undefined; // Box 6

  // Box 7: checkbox -- "FATCA filing requirement" on current MISC layouts is
  // moved to Box 13. Pre-2020 forms had Box 7 as nonemployee comp -- that
  // moved to its own 1099-NEC form starting tax year 2020. We render Box 7
  // as the modern "Payer made direct sales of $5,000 or more" checkbox.
  directSalesCheckbox?: boolean | undefined; // Box 7

  substitutePayments?: string | undefined; // Box 8
  cropInsurance?: string | undefined; // Box 9
  attorneyProceeds?: string | undefined; // Box 10
  fishPurchased?: string | undefined; // Box 11
  section409aDeferrals?: string | undefined; // Box 12
  fatcaCheckbox?: boolean | undefined; // Box 13
  excessGoldenParachute?: string | undefined; // Box 14
  nonqualifiedDeferred?: string | undefined; // Box 15

  // State row
  stateTaxWithheld?: string | undefined; // Box 16
  payerStateId?: string | undefined; // Box 17
  stateIncome?: string | undefined; // Box 18

  corrected?: boolean | undefined;
}

const COPY_LABEL: Record<CopyType, string> = {
  B: 'Copy B — For Recipient',
  C: 'Copy C — For Payer',
  '1': 'Copy 1 — For State Tax Department',
  '2': "Copy 2 — To be filed with recipient's state income tax return, when required",
};

const COPY_DESCRIPTION: Record<CopyType, string> = {
  B: "This is important tax information and is being furnished to the IRS. If you are required to file a return, a negligence penalty or other sanction may be imposed on you if this income is taxable and the IRS determines that it has not been reported.",
  C: 'For Payer. Keep this copy with your records.',
  '1': "File this copy with your state's tax department, when required.",
  '2': "Include this copy when filing the recipient's state income tax return, if applicable.",
};

function formatUsd(s: string | undefined): string {
  if (!s) return '';
  const n = Number(s);
  if (!Number.isFinite(n) || n === 0) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatAddressLines(addr: Address): string[] {
  const lines: string[] = [];
  if (addr.street1) lines.push(addr.street1);
  if (addr.street2) lines.push(addr.street2);
  const cityLine = [addr.city, addr.state, addr.postalCode].filter(Boolean).join(', ').trim();
  if (cityLine) lines.push(cityLine);
  if (
    addr.country &&
    addr.country.toUpperCase() !== 'US' &&
    addr.country.toUpperCase() !== 'USA'
  ) {
    lines.push(addr.country);
  }
  return lines;
}

function maskTin(raw: string, _copy: CopyType): string {
  const cleaned = raw.replace(/[^\d]/g, '');
  if (cleaned.length === 0) return raw;
  const formatSsn = (s: string) =>
    s.length === 9 ? `${s.slice(0, 3)}-${s.slice(3, 5)}-${s.slice(5)}` : s;
  const formatEin = (s: string) =>
    s.length === 9 ? `${s.slice(0, 2)}-${s.slice(2)}` : s;
  const looksLikeEin = raw.includes('-') && raw.indexOf('-') === 2;
  if (looksLikeEin || cleaned.length !== 9) return formatEin(cleaned);
  return formatSsn(cleaned);
}

/**
 * Generate one Copy of a 1099-MISC. Returns a PDF byte buffer.
 */
export async function render1099MISC(
  data: NineteenNinetyNineMISCData,
  copy: CopyType,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
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

  const W = 612;
  const margin = 36;
  const right = W - margin;
  const top = 792 - margin;

  // ─── Form header strip ────────────────────────────────────────────────
  draw(`Form 1099-MISC (${data.taxYear})`, margin, top, { size: 14, bold: true });
  draw('Miscellaneous Information', margin, top - 16, { size: 11, bold: true });
  draw('OMB No. 1545-0115', right - 110, top, { size: 8, color: muted });
  draw(COPY_LABEL[copy], right - 250, top - 14, { size: 9, bold: true, color: muted });

  if (data.corrected) {
    draw('CORRECTED', right - 90, top - 28, { size: 11, bold: true, color: rgb(0.7, 0, 0) });
  }

  // ─── Payer block (top-left) ───────────────────────────────────────────
  const payerY = top - 38;
  const payerH = 110;
  rect(margin, payerY - payerH, 360, payerH);
  draw(
    "PAYER'S name, street address, city or town, state, country, ZIP, and phone",
    margin + 4,
    payerY - 12,
    { size: 7, color: muted },
  );
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

  // ─── TIN row (right of payer) ─────────────────────────────────────────
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

  // ─── Right column: amount boxes 1 - 10 (stacked) ──────────────────────
  // Each box is a fixed-height row with label + dollar value.
  const amountBox = (label: string, value: string | undefined, y: number, h = 24) => {
    rect(tinX, y - h, tinW, h);
    draw(label, tinX + 4, y - 9, { size: 7, color: muted, maxWidth: tinW - 8 });
    if (value) {
      draw(`$ ${formatUsd(value)}`, tinX + 8, y - h + 6, { size: 11, bold: true });
    }
  };

  let by = tinTop - 32;
  amountBox('1  Rents', data.rents, by);
  by -= 26;
  amountBox('2  Royalties', data.royalties, by);
  by -= 26;
  amountBox('3  Other income', data.otherIncome, by);
  by -= 26;
  amountBox('4  Federal income tax withheld', data.federalIncomeTaxWithheld, by);
  by -= 26;
  amountBox('5  Fishing boat proceeds', data.fishingBoatProceeds, by);
  by -= 26;
  amountBox('6  Medical and health care payments', data.medicalPayments, by);
  by -= 26;

  // Box 7: checkbox row (no dollar value)
  rect(tinX, by - 20, tinW, 20);
  draw(
    '7  Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale',
    tinX + 4,
    by - 8,
    { size: 7, color: muted, maxWidth: tinW - 28 },
  );
  rect(tinX + tinW - 16, by - 16, 10, 10, 0.8);
  if (data.directSalesCheckbox) {
    draw('X', tinX + tinW - 14, by - 14, { size: 10, bold: true });
  }
  by -= 22;

  amountBox('8  Substitute payments in lieu of dividends or interest', data.substitutePayments, by);
  by -= 26;
  amountBox('9  Crop insurance proceeds', data.cropInsurance, by);
  by -= 26;
  amountBox('10  Gross proceeds paid to an attorney', data.attorneyProceeds, by);

  // ─── Recipient block (left, below payer) ──────────────────────────────
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

  // ─── Account number / 2nd TIN row ─────────────────────────────────────
  const acctY = recipY - recipH - 6;
  const acctH = 22;
  rect(margin, acctY - acctH, 360, acctH);
  draw('Account number (see instructions)', margin + 4, acctY - 8, { size: 7, color: muted });
  if (data.recipient.accountNumber) {
    draw(data.recipient.accountNumber, margin + 6, acctY - 18, { size: 9 });
  }

  // ─── Boxes 11 / 12 (left column, below account number) ────────────────
  const lower1Y = acctY - acctH - 6;
  const lower1H = 26;
  rect(margin, lower1Y - lower1H, 178, lower1H);
  draw('11  Fish purchased for resale', margin + 4, lower1Y - 8, { size: 7, color: muted });
  if (data.fishPurchased) {
    draw(`$ ${formatUsd(data.fishPurchased)}`, margin + 6, lower1Y - 22, {
      size: 10,
      bold: true,
    });
  }
  rect(margin + 180, lower1Y - lower1H, 180, lower1H);
  draw('12  Section 409A deferrals', margin + 184, lower1Y - 8, { size: 7, color: muted });
  if (data.section409aDeferrals) {
    draw(`$ ${formatUsd(data.section409aDeferrals)}`, margin + 186, lower1Y - 22, {
      size: 10,
      bold: true,
    });
  }

  // ─── Boxes 13 (FATCA checkbox) / 14 (excess golden parachute) ─────────
  const lower2Y = lower1Y - lower1H - 6;
  const lower2H = 26;
  rect(margin, lower2Y - lower2H, 178, lower2H);
  draw('13  FATCA filing requirement', margin + 4, lower2Y - 8, { size: 7, color: muted });
  rect(margin + 156, lower2Y - 18, 10, 10, 0.8);
  if (data.fatcaCheckbox) {
    draw('X', margin + 158, lower2Y - 16, { size: 10, bold: true });
  }
  rect(margin + 180, lower2Y - lower2H, 180, lower2H);
  draw('14  Excess golden parachute payments', margin + 184, lower2Y - 8, {
    size: 7,
    color: muted,
  });
  if (data.excessGoldenParachute) {
    draw(`$ ${formatUsd(data.excessGoldenParachute)}`, margin + 186, lower2Y - 22, {
      size: 10,
      bold: true,
    });
  }

  // ─── Box 15 (nonqualified deferred comp) ──────────────────────────────
  const lower3Y = lower2Y - lower2H - 6;
  const lower3H = 26;
  rect(margin, lower3Y - lower3H, 360, lower3H);
  draw('15  Nonqualified deferred compensation', margin + 4, lower3Y - 8, {
    size: 7,
    color: muted,
  });
  if (data.nonqualifiedDeferred) {
    draw(`$ ${formatUsd(data.nonqualifiedDeferred)}`, margin + 6, lower3Y - 22, {
      size: 10,
      bold: true,
    });
  }

  // ─── State row: 16 / 17 / 18 ──────────────────────────────────────────
  const stateY = lower3Y - lower3H - 6;
  const stateH = 36;
  const cell = (W - 2 * margin) / 3;
  rect(margin, stateY - stateH, cell, stateH);
  rect(margin + cell, stateY - stateH, cell, stateH);
  rect(margin + 2 * cell, stateY - stateH, cell, stateH);
  draw('16  State tax withheld', margin + 4, stateY - 10, { size: 7, color: muted });
  if (data.stateTaxWithheld) {
    draw(`$ ${formatUsd(data.stateTaxWithheld)}`, margin + 8, stateY - 24, {
      size: 10,
      bold: true,
    });
  }
  draw("17  State / Payer's state no.", margin + cell + 4, stateY - 10, { size: 7, color: muted });
  if (data.payerStateId) {
    draw(data.payerStateId, margin + cell + 8, stateY - 24, { size: 10, bold: true });
  }
  draw('18  State income', margin + 2 * cell + 4, stateY - 10, { size: 7, color: muted });
  if (data.stateIncome) {
    draw(`$ ${formatUsd(data.stateIncome)}`, margin + 2 * cell + 8, stateY - 24, {
      size: 10,
      bold: true,
    });
  }

  // ─── Footer ───────────────────────────────────────────────────────────
  const footerY = stateY - stateH - 16;
  draw(COPY_DESCRIPTION[copy], margin, footerY, {
    size: 8,
    italic: true,
    color: muted,
    maxWidth: W - 2 * margin,
  });

  draw(`Form 1099-MISC  |  Generated by KPBooks  |  Tax Year ${data.taxYear}`, margin, margin, {
    size: 7,
    color: muted,
  });
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
 * Render multiple copies into a single multi-page PDF.
 */
export async function render1099MISCCopies(
  data: NineteenNinetyNineMISCData,
  copies: CopyType[],
): Promise<Buffer> {
  if (copies.length === 0) {
    throw new Error('at least one copy type required');
  }
  if (copies.length === 1) {
    return render1099MISC(data, copies[0]!);
  }
  const merged = await PDFDocument.create();
  for (const copy of copies) {
    const buf = await render1099MISC(data, copy);
    const src = await PDFDocument.load(buf);
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  const bytes = await merged.save();
  return Buffer.from(bytes);
}

// -- Preflight --------------------------------------------------------------

export interface PreflightIssue {
  field: string;
  message: string;
  fix: 'company-settings' | 'worker-edit' | 'upload-w9' | 'pay-more';
}

/**
 * Per-IRS thresholds. Boxes not listed have no minimum.
 *   $10:  Box 2 (royalties), Box 8 (substitute payments)
 *   $600: Box 1 (rents), Box 3 (other), Box 6 (medical), Box 10 (attorney)
 */
const BOX_THRESHOLDS: Record<string, number> = {
  rents: 600,
  royalties: 10,
  otherIncome: 600,
  medicalPayments: 600,
  substitutePayments: 10,
  attorneyProceeds: 600,
};

const BOX_LABEL: Record<string, string> = {
  rents: 'Box 1 (Rents)',
  royalties: 'Box 2 (Royalties)',
  otherIncome: 'Box 3 (Other income)',
  medicalPayments: 'Box 6 (Medical/health care)',
  substitutePayments: 'Box 8 (Substitute payments)',
  attorneyProceeds: 'Box 10 (Attorney proceeds)',
};

export function preflight1099MISC(input: {
  payer: { name?: string; ein?: string | null; address?: Address | null; phone?: string | null };
  recipient: {
    displayName?: string;
    taxId?: string | null;
    mailingAddress?: Address | null;
  };
  hasW9: boolean;
  /** Box values to validate. Any keys not in BOX_LABEL are ignored. */
  boxes: Record<string, string | undefined>;
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
      message: 'company mailing address is incomplete (need street, city, state, ZIP)',
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

  if (!input.hasW9) {
    issues.push({
      field: 'recipient.w9',
      message: 'no W-9 on file — the IRS requires you obtain one before issuing a 1099',
      fix: 'upload-w9',
    });
  }

  // At least one populated income box.
  const populated = Object.entries(input.boxes).filter(([, v]) => Number(v ?? '0') > 0);
  if (populated.length === 0) {
    issues.push({
      field: 'amount',
      message: 'no income boxes have a value — fill at least one (Box 1 Rents, Box 3 Other, etc.)',
      fix: 'pay-more',
    });
  } else {
    // Per-box threshold check.
    for (const [boxKey, value] of populated) {
      const threshold = BOX_THRESHOLDS[boxKey];
      if (threshold === undefined) continue; // No threshold for this box.
      const n = Number(value);
      if (n < threshold) {
        issues.push({
          field: `box.${boxKey}`,
          message: `${BOX_LABEL[boxKey]} is $${n.toFixed(2)} — below the $${threshold} threshold`,
          fix: 'pay-more',
        });
      }
    }
  }

  return issues;
}
