import { describe, expect, it } from 'vitest';
import { Money, MoneyError, isBalanced, sum } from './index.js';

describe('Money', () => {
  it('constructs from string with NUMERIC(19,4) precision', () => {
    const m = Money.of('1234.5678', 'USD');
    expect(m.toDecimalString()).toBe('1234.5678');
  });

  it('rounds to 4 decimal places using banker rounding', () => {
    expect(Money.of('1.00005', 'USD').toDecimalString()).toBe('1.0000');
    expect(Money.of('1.00015', 'USD').toDecimalString()).toBe('1.0002');
    expect(Money.of('1.00025', 'USD').toDecimalString()).toBe('1.0002');
  });

  it('rejects non-finite numeric input', () => {
    expect(() => Money.of(Number.POSITIVE_INFINITY, 'USD')).toThrow(MoneyError);
    expect(() => Money.of(Number.NaN, 'USD')).toThrow(MoneyError);
  });

  it('add/sub require matching currency', () => {
    const usd = Money.of('10', 'USD');
    const cad = Money.of('10', 'CAD');
    expect(() => usd.add(cad)).toThrow(MoneyError);
    expect(() => usd.sub(cad)).toThrow(MoneyError);
  });

  it('add/sub do not lose precision (the float trap)', () => {
    const a = Money.of('0.1', 'USD');
    const b = Money.of('0.2', 'USD');
    expect(a.add(b).toDecimalString()).toBe('0.3000');
  });

  it('mul/div round to scale 4', () => {
    const m = Money.of('1', 'USD').div(3);
    expect(m.toDecimalString()).toBe('0.3333');
  });

  it('isBalanced detects matching debits and credits', () => {
    const debits = [Money.of('100', 'USD'), Money.of('50', 'USD')];
    const credits = [Money.of('150', 'USD')];
    expect(isBalanced(debits, credits)).toBe(true);
  });

  it('isBalanced rejects mixed currencies', () => {
    const debits = [Money.of('100', 'USD')];
    const credits = [Money.of('100', 'CAD')];
    expect(() => isBalanced(debits, credits)).toThrow(MoneyError);
  });

  it('sum of empty list requires explicit currency', () => {
    expect(() => sum([])).toThrow(MoneyError);
    expect(sum([], 'USD').toDecimalString()).toBe('0.0000');
  });

  it('toMinorUnits emits integer cents-equivalent', () => {
    expect(Money.of('1.23', 'USD').toMinorUnits(2)).toBe('123');
    expect(Money.of('1.2345', 'USD').toMinorUnits(4)).toBe('12345');
  });

  it('fromMinorUnits round-trips', () => {
    const m = Money.fromMinorUnits(12345n, 'USD', 4);
    expect(m.toDecimalString()).toBe('1.2345');
  });

  it('toJSON is stable', () => {
    expect(Money.of('1.5', 'USD').toJSON()).toEqual({ amount: '1.5000', currency: 'USD' });
  });
});
