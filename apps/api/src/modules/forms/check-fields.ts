/**
 * Pure field logic for printed checks: the legal amount line and the MICR
 * encoding. Both are separated from PDF drawing so they can be tested without
 * rendering, because both are the kind of thing a bank rejects when it is
 * wrong and nobody notices until a client's check bounces back.
 */

const ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
/** Short scale, which is what US checks use. */
const SCALES = ['', 'Thousand', 'Million', 'Billion'];

function underThousand(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)]!;
    const r = n % 10;
    return r ? `${t}-${ONES[r]}` : t;
  }
  const h = `${ONES[Math.floor(n / 100)]} Hundred`;
  const r = n % 100;
  return r ? `${h} ${underThousand(r)}` : h;
}

/**
 * The legal amount, as banks expect it: words for dollars, a fraction over 100
 * for cents. "1234.56" -> "One Thousand Two Hundred Thirty-Four and 56/100".
 *
 * When the courtesy (numeric) and legal (written) amounts disagree, the LEGAL
 * amount governs under UCC 3-114 — so this string, not the digits, is what the
 * bank pays. It has to be exact.
 *
 * Takes the ledger's decimal string, never a float: 0.1 + 0.2 has no place
 * anywhere near a check.
 */
export function amountToWords(decimal: string): string {
  const negative = decimal.trim().startsWith('-');
  const [whole = '0', frac = ''] = decimal.trim().replace(/^-/, '').split('.');
  // Round to cents the way currency does, carrying into dollars at .995+.
  const cents4 = (frac + '0000').slice(0, 4);
  let dollars = BigInt(whole || '0');
  let cents = Math.round(Number(cents4) / 100);
  if (cents >= 100) {
    dollars += 1n;
    cents -= 100;
  }

  if (dollars > 999_999_999_999n) {
    throw new Error('amount too large to write on a check');
  }

  let words: string;
  if (dollars === 0n) {
    words = 'Zero';
  } else {
    const groups: string[] = [];
    let rest = dollars;
    let scale = 0;
    while (rest > 0n) {
      const chunk = Number(rest % 1000n);
      if (chunk > 0) {
        const label = SCALES[scale]!;
        groups.unshift(label ? `${underThousand(chunk)} ${label}` : underThousand(chunk));
      }
      rest /= 1000n;
      scale++;
    }
    words = groups.join(' ');
  }

  const line = `${words} and ${String(cents).padStart(2, '0')}/100`;
  return negative ? `MINUS ${line}` : line;
}

/**
 * Fills the rest of the legal-amount line so nobody can add words after the
 * amount. Standard fraud control on a handwritten check, and expected on a
 * printed one.
 */
export function padLegalLine(words: string, targetChars = 96): string {
  const filler = ' ' + '*'.repeat(Math.max(0, targetChars - words.length - 1));
  return words + filler;
}

/** MICR symbols. The glyphs are non-ASCII, so E-13B fonts map them to ASCII. */
export const MICR_SYMBOL = {
  /** ⑆ transit — brackets the routing number. */
  transit: 'T',
  /** ⑈ amount — brackets the amount field (left blank; the bank encodes it). */
  amount: 'A',
  /** ⑇ on-us — separates account and check number. */
  onUs: 'O',
  /** ⑉ dash. */
  dash: 'D',
} as const;

/**
 * ABA routing-number checksum (ANSI X9.9): weights 3,7,1 repeating, total
 * must be divisible by 10. A transposed digit is the classic way a
 * hand-entered routing number goes wrong, and it produces checks that the
 * bank's reader accepts as a DIFFERENT bank.
 */
export function isValidRoutingNumber(routing: string): boolean {
  if (!/^[0-9]{9}$/.test(routing)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(routing[i]) * w[i]!;
  return sum % 10 === 0;
}

export interface MicrParts {
  routingNumber: string;
  accountNumber: string;
  checkNumber: number;
}

/**
 * Builds the MICR line for a business check in the standard US layout:
 *
 *   ⑈ check# ⑈  ⑆ routing ⑆  account ⑇
 *
 * The characters map to whatever ASCII the E-13B font binds them to (see
 * MICR_SYMBOL). Position and pitch are handled by the renderer, not here.
 *
 * Throws rather than emitting a malformed line: an unreadable MICR line means
 * the bank either rejects the check or charges a manual-handling fee, and
 * silently printing a bad one is worse than refusing.
 */
export function buildMicrLine(parts: MicrParts): string {
  const { routingNumber, accountNumber, checkNumber } = parts;
  if (!/^[0-9]{9}$/.test(routingNumber)) {
    throw new Error(`routing number must be exactly 9 digits, got "${routingNumber}"`);
  }
  if (!isValidRoutingNumber(routingNumber)) {
    throw new Error(
      `routing number ${routingNumber} fails the ABA checksum — check it against the bank's ` +
        `records before printing, or every check will be misrouted`,
    );
  }
  if (!/^[0-9]{4,17}$/.test(accountNumber)) {
    throw new Error(`account number must be 4-17 digits with no separators`);
  }
  if (!Number.isInteger(checkNumber) || checkNumber <= 0 || checkNumber > 999_999_999) {
    throw new Error(`check number must be a positive integer`);
  }
  const { transit, onUs, amount } = MICR_SYMBOL;
  const num = String(checkNumber).padStart(4, '0');
  return `${amount}${num}${amount} ${transit}${routingNumber}${transit} ${accountNumber}${onUs}`;
}
