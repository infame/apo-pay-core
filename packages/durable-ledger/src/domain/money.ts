/**
 * This `Money` is a deliberate duplicate of `@apo/pay-core`'s `Money`, not an
 * oversight. `pay-core` has no `main`/`types`/`exports` field, so it isn't
 * resolvable as a workspace dependency today, and sharing the type would
 * couple two packages the spec deliberately keeps talking to each other only
 * over HTTP (docs/todo/02-durable-ledger.md §1). See
 * ADR-0005 for the full rationale.
 *
 * Money is stored as an integer amount in the currency's minor unit
 * (e.g. cents for USD). We never use floating point for money.
 *
 * Currency is an ISO-4217 alpha-3 code. Operations across mismatched
 * currencies throw rather than silently coercing.
 */

import { CurrencyMismatchError, InvalidMoneyError } from "./errors.js";

export type Currency = string; // ISO-4217, validated at construction

const ISO_4217 = /^[A-Z]{3}$/;

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

  static zero(currency: Currency): Money {
    return Money.of(0, currency);
  }

  /** Sums a possibly-empty list; `currency` fixes the zero case. Throws CurrencyMismatchError on any mismatch. */
  static sum(values: Iterable<Money>, currency: Currency): Money {
    let total = Money.zero(currency);
    for (const value of values) {
      total = total.add(value);
    }
    return total;
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

  negate(): Money {
    return new Money(-this.amount, this.currency);
  }

  isZero(): boolean {
    return this.amount === 0;
  }

  isNegative(): boolean {
    return this.amount < 0;
  }

  isPositive(): boolean {
    return this.amount > 0;
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  toJSON(): { amount: number; currency: Currency } {
    return { amount: this.amount, currency: this.currency };
  }
}
