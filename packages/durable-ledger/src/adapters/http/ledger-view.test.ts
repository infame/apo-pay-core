import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LedgerEntry } from "../../domain/entry.js";
import { LedgerAccount } from "../../domain/account.js";
import { Money } from "../../domain/money.js";
import { toLedgerEntryView } from "./ledger-view.js";

describe("toLedgerEntryView", () => {
  it("maps every field, preserving null reversesOperationId and formatting createdAt as ISO-8601", () => {
    const id = randomUUID();
    const operationId = randomUUID();
    const entry = LedgerEntry.fromState({
      id,
      operationId,
      account: LedgerAccount.merchant("42"),
      direction: "credit",
      amount: Money.of(2000, "USD"),
      paymentId: "pay_1",
      entryType: "capture",
      reversesOperationId: null,
      createdAt: new Date("2026-01-01T12:00:00.000Z"),
    });

    const view = toLedgerEntryView(entry);

    expect(view).toEqual({
      id,
      operationId,
      account: "merchant:42",
      direction: "credit",
      amount: { amount: 2000, currency: "USD" },
      paymentId: "pay_1",
      entryType: "capture",
      reversesOperationId: null,
      createdAt: "2026-01-01T12:00:00.000Z",
    });
  });

  it("carries a non-null reversesOperationId through for a reversal entry", () => {
    const originalOperationId = randomUUID();
    const entry = LedgerEntry.fromState({
      id: randomUUID(),
      operationId: randomUUID(),
      account: LedgerAccount.acquirerClearing(),
      direction: "credit",
      amount: Money.of(500, "EUR"),
      paymentId: "pay_2",
      entryType: "reversal",
      reversesOperationId: originalOperationId,
      createdAt: new Date("2026-02-15T00:00:00.000Z"),
    });

    const view = toLedgerEntryView(entry);

    expect(view.entryType).toBe("reversal");
    expect(view.reversesOperationId).toBe(originalOperationId);
    expect(view.account).toBe("acquirer_clearing");
  });

  it("serializes the amount using Money's own toJSON shape", () => {
    const entry = LedgerEntry.fromState({
      id: randomUUID(),
      operationId: randomUUID(),
      account: LedgerAccount.customer("7"),
      direction: "debit",
      amount: Money.of(1234, "GBP"),
      paymentId: "pay_3",
      entryType: "refund",
      reversesOperationId: null,
      createdAt: new Date(),
    });

    expect(toLedgerEntryView(entry).amount).toEqual({
      amount: 1234,
      currency: "GBP",
    });
  });
});
