import { describe, expect, it } from "vitest";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
} from "./money.js";

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
    expect(() => Money.of(100, "USD").greaterThan(Money.of(1, "EUR"))).toThrow(
      CurrencyMismatchError,
    );
  });

  it("compares by value", () => {
    expect(Money.of(100, "USD").equals(Money.of(100, "USD"))).toBe(true);
    expect(Money.of(100, "USD").greaterThan(Money.of(99, "USD"))).toBe(true);
  });
});
