import { Decimal } from 'decimal.js';

Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -7,
  toExpPos: 21,
});

export type CurrencyCode = string;

export const SCALE = 4 as const;

export type MoneyInput = string | number | Decimal | Money;

export class Money {
  private readonly amount: Decimal;
  public readonly currency: CurrencyCode;

  private constructor(amount: Decimal, currency: CurrencyCode) {
    this.amount = amount;
    this.currency = currency;
  }

  static of(value: MoneyInput, currency: CurrencyCode): Money {
    if (value instanceof Money) {
      if (value.currency !== currency) {
        throw new MoneyError(
          `cannot construct Money: existing currency ${value.currency} != ${currency}`,
        );
      }
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new MoneyError(`cannot construct Money from non-finite number: ${value}`);
      }
      return new Money(new Decimal(value).toDecimalPlaces(SCALE, Decimal.ROUND_HALF_EVEN), currency);
    }
    return new Money(
      (value instanceof Decimal ? value : new Decimal(value)).toDecimalPlaces(
        SCALE,
        Decimal.ROUND_HALF_EVEN,
      ),
      currency,
    );
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(new Decimal(0), currency);
  }

  static fromMinorUnits(minor: bigint | number, currency: CurrencyCode, exponent = SCALE): Money {
    const d = new Decimal(minor.toString()).div(new Decimal(10).pow(exponent));
    return new Money(d.toDecimalPlaces(SCALE, Decimal.ROUND_HALF_EVEN), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  sub(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  mul(scalar: string | number | Decimal): Money {
    const s = scalar instanceof Decimal ? scalar : new Decimal(scalar);
    return new Money(
      this.amount.mul(s).toDecimalPlaces(SCALE, Decimal.ROUND_HALF_EVEN),
      this.currency,
    );
  }

  div(scalar: string | number | Decimal): Money {
    const s = scalar instanceof Decimal ? scalar : new Decimal(scalar);
    if (s.isZero()) throw new MoneyError('division by zero');
    return new Money(
      this.amount.div(s).toDecimalPlaces(SCALE, Decimal.ROUND_HALF_EVEN),
      this.currency,
    );
  }

  negate(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.isPositive() && !this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative();
  }

  cmp(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.amount.cmp(other.amount) as -1 | 0 | 1;
  }

  eq(other: Money): boolean {
    return this.cmp(other) === 0;
  }

  /** Decimal string with full precision, e.g. "1234.5600" */
  toDecimalString(): string {
    return this.amount.toFixed(SCALE);
  }

  /** Numeric value safe to send to Postgres NUMERIC columns (string form) */
  toPgNumeric(): string {
    return this.toDecimalString();
  }

  /** Minor units (integer string) — useful for ACH/NACHA and APIs that demand cents */
  toMinorUnits(exponent = SCALE): string {
    return this.amount.mul(new Decimal(10).pow(exponent)).toFixed(0);
  }

  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.toDecimalString(), currency: this.currency };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Sum a list of Money values; all must share a currency. Throws on empty input without explicit currency. */
export function sum(values: Money[], currency?: CurrencyCode): Money {
  if (values.length === 0) {
    if (!currency) throw new MoneyError('cannot sum empty list without explicit currency');
    return Money.zero(currency);
  }
  return values.reduce((acc, v) => acc.add(v), Money.zero(values[0]!.currency));
}

/** True if a list of debits and credits balances to exactly zero (for double-entry posting). */
export function isBalanced(debits: Money[], credits: Money[]): boolean {
  if (debits.length === 0 && credits.length === 0) return true;
  const all = [...debits, ...credits];
  const currency = all[0]!.currency;
  if (!all.every((m) => m.currency === currency)) {
    throw new MoneyError('isBalanced: mixed currencies');
  }
  return sum(debits, currency).eq(sum(credits, currency));
}
