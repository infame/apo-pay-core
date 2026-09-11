import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LedgerAccount } from "./account.js";
import {
  assertZeroSum,
  balanceOf,
  balanceSheet,
  isBalanced,
  residuals,
} from "./balances.js";
import { LedgerEntry, PostingGroup } from "./entry.js";
import { LedgerImbalanceError } from "./errors.js";
import { Money } from "./money.js";

describe("balanceOf", () => {
  it("returns zero(currency) for an empty entry list", () => {
    const balance = balanceOf([], LedgerAccount.merchant("42"), "USD");
    expect(balance.equals(Money.zero("USD"))).toBe(true);
  });

  it("after a capture: merchant is +amount, acquirer_clearing is -amount (sign convention, §3.4)", () => {
    const group = PostingGroup.forCapture({
      operationId: randomUUID(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(1000, "USD"),
    });
    const merchantBalance = balanceOf(
      group.entries,
      LedgerAccount.merchant("42"),
      "USD",
    );
    const clearingBalance = balanceOf(
      group.entries,
      LedgerAccount.acquirerClearing(),
      "USD",
    );
    expect(merchantBalance.amount).toBe(1000);
    // acquirer_clearing runs NEGATIVE after a capture — it's a
    // clearing/liability account. This is correct, not a bug.
    expect(clearingBalance.amount).toBe(-1000);
  });

  it("a capture followed by a partial refund leaves the expected per-account balances with a zero residual", () => {
    const capture = PostingGroup.forCapture({
      operationId: randomUUID(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(1000, "USD"),
    });
    const refund = PostingGroup.forRefund({
      operationId: randomUUID(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(300, "USD"),
    });
    const entries = [...capture.entries, ...refund.entries];

    const merchantBalance = balanceOf(
      entries,
      LedgerAccount.merchant("42"),
      "USD",
    );
    const clearingBalance = balanceOf(
      entries,
      LedgerAccount.acquirerClearing(),
      "USD",
    );
    expect(merchantBalance.amount).toBe(700);
    expect(clearingBalance.amount).toBe(-700);
    expect(isBalanced(entries)).toBe(true);
    expect(residuals(entries).get("USD")?.isZero()).toBe(true);
  });

  it("keeps two different currencies fully isolated", () => {
    const usdCapture = PostingGroup.forCapture({
      operationId: randomUUID(),
      paymentId: "pay_usd",
      merchantId: "1",
      amount: Money.of(500, "USD"),
    });
    const eurCapture = PostingGroup.forCapture({
      operationId: randomUUID(),
      paymentId: "pay_eur",
      merchantId: "1",
      amount: Money.of(200, "EUR"),
    });
    const entries = [...usdCapture.entries, ...eurCapture.entries];

    expect(balanceOf(entries, LedgerAccount.merchant("1"), "USD").amount).toBe(
      500,
    );
    expect(balanceOf(entries, LedgerAccount.merchant("1"), "EUR").amount).toBe(
      200,
    );

    const allResiduals = residuals(entries);
    expect(allResiduals.get("USD")?.isZero()).toBe(true);
    expect(allResiduals.get("EUR")?.isZero()).toBe(true);

    const sheet = balanceSheet(entries);
    expect(sheet.get("merchant:1|USD")?.amount).toBe(500);
    expect(sheet.get("merchant:1|EUR")?.amount).toBe(200);
  });
});

describe("assertZeroSum", () => {
  it("throws LedgerImbalanceError for a hand-built imbalanced entry list bypassing PostingGroup", () => {
    // PostingGroup would refuse to construct this — build LedgerEntry
    // instances directly via fromState to prove the projection layer
    // independently catches what construction prevents.
    const operationId = randomUUID();
    const now = new Date();
    const entries = [
      LedgerEntry.fromState({
        id: randomUUID(),
        operationId,
        account: LedgerAccount.acquirerClearing(),
        direction: "debit",
        amount: Money.of(100, "USD"),
        paymentId: "pay_1",
        entryType: "capture",
        reversesOperationId: null,
        createdAt: now,
      }),
      LedgerEntry.fromState({
        id: randomUUID(),
        operationId,
        account: LedgerAccount.merchant("1"),
        direction: "credit",
        amount: Money.of(90, "USD"),
        paymentId: "pay_1",
        entryType: "capture",
        reversesOperationId: null,
        createdAt: now,
      }),
    ];

    expect(() => assertZeroSum(entries)).toThrow(LedgerImbalanceError);
    let caught: unknown;
    try {
      assertZeroSum(entries);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LedgerImbalanceError);
    const error = caught as LedgerImbalanceError;
    expect(error.residuals.get("USD")?.amount).toBe(-10);
  });

  it("does not throw for a balanced entry list", () => {
    const group = PostingGroup.forCapture({
      operationId: randomUUID(),
      paymentId: "pay_1",
      merchantId: "1",
      amount: Money.of(100, "USD"),
    });
    expect(() => assertZeroSum(group.entries)).not.toThrow();
  });
});
