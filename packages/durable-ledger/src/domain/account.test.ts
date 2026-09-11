import { describe, expect, it } from "vitest";
import { LedgerAccount } from "./account.js";
import { InvalidAccountError } from "./errors.js";

describe("LedgerAccount", () => {
  it("renders merchant accounts as kind:subject", () => {
    expect(LedgerAccount.merchant("42").toString()).toBe("merchant:42");
  });

  it("renders customer accounts as kind:subject", () => {
    expect(LedgerAccount.customer("7").toString()).toBe("customer:7");
  });

  it("renders acquirer_clearing with no subject", () => {
    const account = LedgerAccount.acquirerClearing();
    expect(account.toString()).toBe("acquirer_clearing");
    expect(account.subject).toBeNull();
  });

  it("rejects a subject on acquirer_clearing", () => {
    expect(() => LedgerAccount.parse("acquirer_clearing:5")).toThrow(
      InvalidAccountError,
    );
  });

  it("round-trips all three account kinds through parse", () => {
    expect(
      LedgerAccount.parse("merchant:42").equals(LedgerAccount.merchant("42")),
    ).toBe(true);
    expect(
      LedgerAccount.parse("customer:7").equals(LedgerAccount.customer("7")),
    ).toBe(true);
    expect(
      LedgerAccount.parse("acquirer_clearing").equals(
        LedgerAccount.acquirerClearing(),
      ),
    ).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(() => LedgerAccount.parse("wallet:1")).toThrow(InvalidAccountError);
  });

  it("rejects an empty subject", () => {
    expect(() => LedgerAccount.parse("merchant:")).toThrow(InvalidAccountError);
    expect(() => LedgerAccount.merchant("")).toThrow(InvalidAccountError);
  });

  it("rejects a subject containing a colon", () => {
    expect(() => LedgerAccount.parse("merchant:4:2")).toThrow(
      InvalidAccountError,
    );
    expect(() => LedgerAccount.merchant("4:2")).toThrow(InvalidAccountError);
  });

  it("compares by value, not reference", () => {
    expect(
      LedgerAccount.merchant("42").equals(LedgerAccount.merchant("42")),
    ).toBe(true);
    expect(
      LedgerAccount.merchant("42").equals(LedgerAccount.merchant("43")),
    ).toBe(false);
    expect(
      LedgerAccount.merchant("42").equals(LedgerAccount.customer("42")),
    ).toBe(false);
  });
});
