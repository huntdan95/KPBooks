/**
 * recurring/dates.ts -- pure date math for recurring templates. Kept in its
 * own module (no DB / no SQL) so the rules are unit-testable without a fixture
 * database. All dates are ISO strings YYYY-MM-DD treated as calendar dates;
 * we never touch wall-clock time so timezones don't enter the math.
 */

export type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annually';

export interface Schedule {
  frequency: Frequency;
  startDate: string;
  /** 1..31; 31 = last day of month. Required for monthly/quarterly/annually. */
  dayOfMonth?: number | null;
  /** 0..6 (0=Sun .. 6=Sat). Required for weekly/biweekly. */
  dayOfWeek?: number | null;
}

/** Parse a YYYY-MM-DD string into a UTC Date, no timezone shenanigans. */
export function parseIsoDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad ISO date "${s}"`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function formatIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Days in the given (1-based) month and year, with leap-year handling. */
export function daysInMonth(year: number, month1Based: number): number {
  return new Date(Date.UTC(year, month1Based, 0)).getUTCDate();
}

/**
 * Return the date in `year-month` for the rule day_of_month, where
 * day=31 means "last day of month". Clamps so day 31 in February
 * resolves to 28/29, not skip-and-spill into March.
 */
function dateForDom(year: number, month0Based: number, dom: number): Date {
  // Normalize month into year (handles month overflow, e.g. month=12 -> next year jan)
  const norm = new Date(Date.UTC(year, month0Based, 1));
  const ny = norm.getUTCFullYear();
  const nm0 = norm.getUTCMonth();
  const last = daysInMonth(ny, nm0 + 1);
  const useDay = Math.min(dom, last);
  return new Date(Date.UTC(ny, nm0, useDay));
}

function addDaysUtc(d: Date, days: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
}

function addMonthsUtc(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
}

/**
 * The first run-date for a brand-new template: the earliest date >= startDate
 * that satisfies the frequency rule. For monthly/quarterly/annually this means
 * "the next occurrence of dayOfMonth at or after start"; for weekly/biweekly,
 * "the next occurrence of dayOfWeek at or after start".
 */
export function firstRunDate(s: Schedule): string {
  const start = parseIsoDate(s.startDate);
  const startTime = start.getTime();
  if (s.frequency === 'weekly' || s.frequency === 'biweekly') {
    if (s.dayOfWeek == null) {
      throw new Error('weekly/biweekly schedule requires dayOfWeek');
    }
    const startDow = start.getUTCDay();
    const offset = (s.dayOfWeek - startDow + 7) % 7;
    return formatIsoDate(addDaysUtc(start, offset));
  }
  if (s.dayOfMonth == null) {
    throw new Error('monthly/quarterly/annually schedule requires dayOfMonth');
  }
  // Try this month first; if it's already past, advance one period.
  const candThis = dateForDom(start.getUTCFullYear(), start.getUTCMonth(), s.dayOfMonth);
  if (candThis.getTime() >= startTime) {
    return formatIsoDate(candThis);
  }
  const stepMonths = s.frequency === 'monthly' ? 1 : s.frequency === 'quarterly' ? 3 : 12;
  const next = dateForDom(
    start.getUTCFullYear(),
    start.getUTCMonth() + stepMonths,
    s.dayOfMonth,
  );
  return formatIsoDate(next);
}

/**
 * After a successful firing, what's the next run-date? Always strictly after
 * the just-fired date (we don't want a tight loop in run-all-due if today's
 * date drift lands the same day).
 */
export function nextRunDate(s: Schedule, justFiredIso: string): string {
  const fired = parseIsoDate(justFiredIso);
  switch (s.frequency) {
    case 'weekly':
      return formatIsoDate(addDaysUtc(fired, 7));
    case 'biweekly':
      return formatIsoDate(addDaysUtc(fired, 14));
    case 'monthly':
    case 'quarterly':
    case 'annually': {
      if (s.dayOfMonth == null) {
        throw new Error('monthly/quarterly/annually schedule requires dayOfMonth');
      }
      const stepMonths = s.frequency === 'monthly' ? 1 : s.frequency === 'quarterly' ? 3 : 12;
      const candidate = dateForDom(
        fired.getUTCFullYear(),
        fired.getUTCMonth() + stepMonths,
        s.dayOfMonth,
      );
      // If clamping (e.g. fired on last-day-of-month rule) lands on the same
      // day, push another period. This only happens for day=31 + 30/31 rotations.
      if (candidate.getTime() <= fired.getTime()) {
        return formatIsoDate(
          dateForDom(
            fired.getUTCFullYear(),
            fired.getUTCMonth() + 2 * stepMonths,
            s.dayOfMonth,
          ),
        );
      }
      return formatIsoDate(candidate);
    }
    default: {
      const _exhaustive: never = s.frequency;
      throw new Error(`unknown frequency: ${String(_exhaustive)}`);
    }
  }
}

/** Returns true if `a` is on-or-before `b` (both YYYY-MM-DD). */
export function isOnOrBefore(a: string, b: string): boolean {
  return parseIsoDate(a).getTime() <= parseIsoDate(b).getTime();
}

export function todayIso(): string {
  return formatIsoDate(new Date(Date.now()));
}

/** Generate a deterministic, human-readable invoice/bill number from a template
 *  + run-count. Example: "REC-20260508-3-a533e5". The template-id-suffix
 *  guarantees per-company uniqueness even if two templates fire on the same day. */
export function generateRecurringNumber(opts: {
  prefix?: string | undefined;
  date: string;
  runCount: number;
  templateId: string;
}): string {
  const prefix = (opts.prefix && opts.prefix.trim()) || 'REC';
  const stamp = opts.date.replace(/-/g, '');
  const tail = opts.templateId.replace(/-/g, '').slice(0, 6);
  return `${prefix}-${stamp}-${opts.runCount}-${tail}`.slice(0, 40);
}
