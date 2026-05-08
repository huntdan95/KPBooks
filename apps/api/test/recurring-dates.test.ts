import { describe, expect, it } from 'vitest';
import {
  daysInMonth,
  firstRunDate,
  generateRecurringNumber,
  isOnOrBefore,
  nextRunDate,
} from '../src/modules/recurring/dates.js';

describe('daysInMonth', () => {
  it('handles leap year February', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(2026, 2)).toBe(28);
    // 2100 is divisible by 100 but not 400, so NOT a leap year
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });
  it('handles 30/31-day months', () => {
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 7)).toBe(31);
  });
});

describe('firstRunDate - monthly', () => {
  it('returns dayOfMonth in the start month if not yet past', () => {
    expect(
      firstRunDate({
        frequency: 'monthly',
        startDate: '2026-05-01',
        dayOfMonth: 15,
      }),
    ).toBe('2026-05-15');
    expect(
      firstRunDate({
        frequency: 'monthly',
        startDate: '2026-05-15',
        dayOfMonth: 15,
      }),
    ).toBe('2026-05-15');
  });

  it('rolls to next month when start is past dayOfMonth', () => {
    expect(
      firstRunDate({
        frequency: 'monthly',
        startDate: '2026-05-20',
        dayOfMonth: 15,
      }),
    ).toBe('2026-06-15');
  });

  it('clamps day=31 to last day of February', () => {
    expect(
      firstRunDate({
        frequency: 'monthly',
        startDate: '2026-02-01',
        dayOfMonth: 31,
      }),
    ).toBe('2026-02-28');
    expect(
      firstRunDate({
        frequency: 'monthly',
        startDate: '2024-02-01',
        dayOfMonth: 31,
      }),
    ).toBe('2024-02-29');
  });

  it('clamps day=31 to last day of April (30)', () => {
    expect(
      firstRunDate({
        frequency: 'monthly',
        startDate: '2026-04-01',
        dayOfMonth: 31,
      }),
    ).toBe('2026-04-30');
  });
});

describe('firstRunDate - weekly / biweekly', () => {
  it('snaps to the next requested weekday', () => {
    // 2026-05-04 is a Monday (dow=1). Schedule on Friday (dow=5).
    expect(
      firstRunDate({
        frequency: 'weekly',
        startDate: '2026-05-04',
        dayOfWeek: 5,
      }),
    ).toBe('2026-05-08');
  });

  it('returns the start date itself when start IS the target weekday', () => {
    // 2026-05-08 is a Friday (dow=5)
    expect(
      firstRunDate({
        frequency: 'biweekly',
        startDate: '2026-05-08',
        dayOfWeek: 5,
      }),
    ).toBe('2026-05-08');
  });

  it('throws when dayOfWeek missing for weekly', () => {
    expect(() =>
      firstRunDate({
        frequency: 'weekly',
        startDate: '2026-05-04',
      }),
    ).toThrow();
  });
});

describe('firstRunDate - quarterly / annually', () => {
  it('quarterly advances by 3 months when start date is past dayOfMonth', () => {
    expect(
      firstRunDate({
        frequency: 'quarterly',
        startDate: '2026-05-20',
        dayOfMonth: 15,
      }),
    ).toBe('2026-08-15');
  });
  it('annually advances by 12 months when past', () => {
    expect(
      firstRunDate({
        frequency: 'annually',
        startDate: '2026-12-31',
        dayOfMonth: 1,
      }),
    ).toBe('2027-12-01');
  });
});

describe('nextRunDate - weekly / biweekly', () => {
  it('weekly adds 7 days', () => {
    expect(
      nextRunDate(
        { frequency: 'weekly', startDate: '2026-05-04', dayOfWeek: 5 },
        '2026-05-08',
      ),
    ).toBe('2026-05-15');
  });
  it('biweekly adds 14 days, including across month boundary', () => {
    expect(
      nextRunDate(
        { frequency: 'biweekly', startDate: '2026-04-25', dayOfWeek: 5 },
        '2026-04-25',
      ),
    ).toBe('2026-05-09');
  });
});

describe('nextRunDate - monthly day=31 last-day-of-month rule', () => {
  it('walks Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31 ...', () => {
    const sched = { frequency: 'monthly' as const, startDate: '2026-01-31', dayOfMonth: 31 };
    expect(nextRunDate(sched, '2026-01-31')).toBe('2026-02-28');
    expect(nextRunDate(sched, '2026-02-28')).toBe('2026-03-31');
    expect(nextRunDate(sched, '2026-03-31')).toBe('2026-04-30');
    expect(nextRunDate(sched, '2026-04-30')).toBe('2026-05-31');
  });

  it('handles leap-year February correctly', () => {
    const sched = { frequency: 'monthly' as const, startDate: '2024-01-31', dayOfMonth: 31 };
    expect(nextRunDate(sched, '2024-01-31')).toBe('2024-02-29');
    expect(nextRunDate(sched, '2024-02-29')).toBe('2024-03-31');
  });
});

describe('nextRunDate - quarterly / annually', () => {
  it('quarterly advances by 3 months', () => {
    expect(
      nextRunDate(
        { frequency: 'quarterly', startDate: '2026-01-15', dayOfMonth: 15 },
        '2026-01-15',
      ),
    ).toBe('2026-04-15');
  });
  it('annually advances by 12 months', () => {
    expect(
      nextRunDate(
        { frequency: 'annually', startDate: '2026-04-15', dayOfMonth: 15 },
        '2026-04-15',
      ),
    ).toBe('2027-04-15');
  });
});

describe('isOnOrBefore', () => {
  it('handles equal and before/after', () => {
    expect(isOnOrBefore('2026-05-08', '2026-05-08')).toBe(true);
    expect(isOnOrBefore('2026-05-07', '2026-05-08')).toBe(true);
    expect(isOnOrBefore('2026-05-09', '2026-05-08')).toBe(false);
  });
});

describe('generateRecurringNumber', () => {
  it('produces a deterministic, unique-per-template number', () => {
    const n = generateRecurringNumber({
      prefix: 'REC',
      date: '2026-05-08',
      runCount: 3,
      templateId: 'a533e5ff-95f3-4583-8147-6d03cdf6d563',
    });
    expect(n).toBe('REC-20260508-3-a533e5');
  });
  it('defaults prefix to REC when not provided', () => {
    expect(
      generateRecurringNumber({
        date: '2026-05-08',
        runCount: 1,
        templateId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }),
    ).toBe('REC-20260508-1-aaaaaa');
  });
  it('respects custom prefix', () => {
    expect(
      generateRecurringNumber({
        prefix: 'RENT',
        date: '2026-05-01',
        runCount: 1,
        templateId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }),
    ).toBe('RENT-20260501-1-aaaaaa');
  });
});
