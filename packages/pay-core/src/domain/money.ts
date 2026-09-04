/**
 * Money is stored as an integer amount in the currency's minor unit
 * (e.g. cents for USD). We never use floating point for money.
 *
 * Currency is an ISO-4217 alpha-3 code. Operations across mismatched
 * currencies throw rather than silently coercing.
 */

export type Currency = string; // ISO-4217, validated at construction

const ISO_4217 = /^[A-Z]{3}$/;

export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyError";
  }
}

export class Money {
  private constructor(
    /** Amount in minor units (cents). Always an integer. */
    readonly amount: number,
    readonly currency: Currency,
  ) {}

  static of(amount: number, currency: Currency): Money {
    if (!Number.isInteger(amount)) {
      throw new InvalidMoneyError(
        `Amount must be an integer in minor units, got ${amount}`,
      );
    }
    if (!ISO_4217.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency code: ${currency}`);
    }
    return new Money(amount, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  isZero(): boolean {
    return this.amount === 0;
  }

  isNegative(): boolean {
    return this.amount < 0;
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }

  /** Greater-than comparison. Throws on currency mismatch. */
  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount > other.amount;
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  toJSON(): { amount: number; currency: Currency } {
    return { amount: this.amount, currency: this.currency };
  }
}
