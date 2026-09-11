import { describe, expect, it } from "vitest";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors.js";
import { Money } from "./money.js";

describe("Money", () => {
  it("rejects non-integer amounts", () => {
    expect(() => Money.of(1.5, "USD")).toThrow(InvalidMoneyError);
  });

  it("rejects malformed currency codes", () => {
    expect(() => Money.of(100, "usd")).toThrow(InvalidMoneyError);
    expect(() => Money.of(100, "US")).toThrow(InvalidMoneyError);
  });

  it("adds and subtracts within the same currency", () => {
    expect(Money.of(100, "USD").add(Money.of(50, "USD")).amount).toBe(150);
    expect(Money.of(100, "USD").subtract(Money.of(30, "USD")).amount).toBe(70);
  });

  it("refuses operations across currencies", () => {
    expect(() => Money.of(100, "USD").add(Money.of(1, "EUR"))).toThrow(
      CurrencyMismatchError,
    );
  });

  it("compares by value", () => {
    expect(Money.of(100, "USD").equals(Money.of(100, "USD"))).toBe(true);
    expect(Money.of(100, "USD").equals(Money.of(99, "USD"))).toBe(false);
  });

  it("sums an empty iterable to zero(currency)", () => {
    expect(Money.sum([], "USD").equals(Money.zero("USD"))).toBe(true);
  });

  it("sums a list of same-currency values", () => {
    const total = Money.sum(
      [Money.of(100, "USD"), Money.of(50, "USD"), Money.of(25, "USD")],
      "USD",
    );
    expect(total.amount).toBe(175);
  });

  it("throws CurrencyMismatchError on a mixed-currency sum", () => {
    expect(() =>
      Money.sum([Money.of(100, "USD"), Money.of(50, "EUR")], "USD"),
    ).toThrow(CurrencyMismatchError);
  });

  it("negates", () => {
    expect(Money.of(100, "USD").negate().amount).toBe(-100);
    expect(Money.of(-100, "USD").negate().amount).toBe(100);
    expect(Money.of(0, "USD").negate().isZero()).toBe(true);
  });

  it("isPositive is false at exactly 0", () => {
    expect(Money.of(0, "USD").isPositive()).toBe(false);
    expect(Money.of(1, "USD").isPositive()).toBe(true);
    expect(Money.of(-1, "USD").isPositive()).toBe(false);
  });
});
