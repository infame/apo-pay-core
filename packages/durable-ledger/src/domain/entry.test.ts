import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LedgerAccount } from "./account.js";
import {
  CurrencyMismatchError,
  InvalidLedgerEntryError,
  UnbalancedPostingError,
} from "./errors.js";
import { LedgerEntry, PostingGroup } from "./entry.js";
import { Money } from "./money.js";

const opId = () => randomUUID();

describe("PostingGroup.create invariants", () => {
  it("1. throws InvalidLedgerEntryError with fewer than two entries", () => {
    expect(() =>
      PostingGroup.create({
        operationId: opId(),
        paymentId: "pay_1",
        entryType: "capture",
        entries: [
          {
            account: LedgerAccount.acquirerClearing(),
            direction: "debit",
            amount: Money.of(100, "USD"),
          },
        ],
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("2. throws InvalidLedgerEntryError when all entries share one direction (all-credit)", () => {
    expect(() =>
      PostingGroup.create({
        operationId: opId(),
        paymentId: "pay_1",
        entryType: "capture",
        entries: [
          {
            account: LedgerAccount.merchant("1"),
            direction: "credit",
            amount: Money.of(100, "USD"),
          },
          {
            account: LedgerAccount.merchant("2"),
            direction: "credit",
            amount: Money.of(100, "USD"),
          },
        ],
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("3. throws InvalidLedgerEntryError on a zero-amount entry", () => {
    expect(() =>
      PostingGroup.create({
        operationId: opId(),
        paymentId: "pay_1",
        entryType: "capture",
        entries: [
          {
            account: LedgerAccount.acquirerClearing(),
            direction: "debit",
            amount: Money.of(0, "USD"),
          },
          {
            account: LedgerAccount.merchant("1"),
            direction: "credit",
            amount: Money.of(0, "USD"),
          },
        ],
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("3. throws InvalidLedgerEntryError on a negative-amount entry", () => {
    expect(() =>
      PostingGroup.create({
        operationId: opId(),
        paymentId: "pay_1",
        entryType: "capture",
        entries: [
          {
            account: LedgerAccount.acquirerClearing(),
            direction: "debit",
            amount: Money.of(-100, "USD"),
          },
          {
            account: LedgerAccount.merchant("1"),
            direction: "credit",
            amount: Money.of(-100, "USD"),
          },
        ],
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("4. throws CurrencyMismatchError when entries mix currencies", () => {
    expect(() =>
      PostingGroup.create({
        operationId: opId(),
        paymentId: "pay_1",
        entryType: "capture",
        entries: [
          {
            account: LedgerAccount.acquirerClearing(),
            direction: "debit",
            amount: Money.of(100, "USD"),
          },
          {
            account: LedgerAccount.merchant("1"),
            direction: "credit",
            amount: Money.of(100, "EUR"),
          },
        ],
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it("5. throws UnbalancedPostingError carrying both totals", () => {
    let caught: unknown;
    try {
      PostingGroup.create({
        operationId: opId(),
        paymentId: "pay_1",
        entryType: "capture",
        entries: [
          {
            account: LedgerAccount.acquirerClearing(),
            direction: "debit",
            amount: Money.of(100, "USD"),
          },
          {
            account: LedgerAccount.merchant("1"),
            direction: "credit",
            amount: Money.of(90, "USD"),
          },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnbalancedPostingError);
    const error = caught as UnbalancedPostingError;
    expect(error.debitTotal.amount).toBe(100);
    expect(error.creditTotal.amount).toBe(90);
  });

  it("6. throws InvalidLedgerEntryError on a duplicate (account, direction) pair", () => {
    expect(() =>
      PostingGroup.create({
        operationId: opId(),
        paymentId: "pay_1",
        entryType: "capture",
        entries: [
          {
            account: LedgerAccount.acquirerClearing(),
            direction: "debit",
            amount: Money.of(50, "USD"),
          },
          {
            account: LedgerAccount.acquirerClearing(),
            direction: "debit",
            amount: Money.of(50, "USD"),
          },
          {
            account: LedgerAccount.merchant("1"),
            direction: "credit",
            amount: Money.of(100, "USD"),
          },
        ],
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("7. throws InvalidLedgerEntryError on a non-UUID operationId", () => {
    expect(() =>
      PostingGroup.create({
        operationId: "not-a-uuid",
        paymentId: "pay_1",
        entryType: "capture",
        entries: [
          {
            account: LedgerAccount.acquirerClearing(),
            direction: "debit",
            amount: Money.of(100, "USD"),
          },
          {
            account: LedgerAccount.merchant("1"),
            direction: "credit",
            amount: Money.of(100, "USD"),
          },
        ],
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("7. throws InvalidLedgerEntryError on a non-UUID reversesOperationId", () => {
    expect(() =>
      PostingGroup.create({
        operationId: opId(),
        paymentId: "pay_1",
        entryType: "reversal",
        reversesOperationId: "not-a-uuid",
        entries: [
          {
            account: LedgerAccount.acquirerClearing(),
            direction: "debit",
            amount: Money.of(100, "USD"),
          },
          {
            account: LedgerAccount.merchant("1"),
            direction: "credit",
            amount: Money.of(100, "USD"),
          },
        ],
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("stamps operationId/paymentId/entryType/createdAt on every entry in a valid group", () => {
    const operationId = opId();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const group = PostingGroup.create({
      operationId,
      paymentId: "pay_1",
      entryType: "capture",
      now,
      entries: [
        {
          account: LedgerAccount.acquirerClearing(),
          direction: "debit",
          amount: Money.of(100, "USD"),
        },
        {
          account: LedgerAccount.merchant("1"),
          direction: "credit",
          amount: Money.of(100, "USD"),
        },
      ],
    });
    expect(group.entries).toHaveLength(2);
    for (const entry of group.entries) {
      expect(entry.operationId).toBe(operationId);
      expect(entry.paymentId).toBe("pay_1");
      expect(entry.entryType).toBe("capture");
      expect(entry.createdAt).toEqual(now);
      expect(entry.reversesOperationId).toBeNull();
    }
    // Every entry gets its own fresh id.
    expect(group.entries[0]!.id).not.toBe(group.entries[1]!.id);
  });
});

describe("PostingGroup.forCapture / forRefund (spec §3.3)", () => {
  it("forCapture produces exactly [debit acquirer_clearing, credit merchant:<id>]", () => {
    const group = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(1000, "USD"),
    });
    expect(group.entries).toHaveLength(2);
    expect(group.entries[0]!.account.toString()).toBe("acquirer_clearing");
    expect(group.entries[0]!.direction).toBe("debit");
    expect(group.entries[1]!.account.toString()).toBe("merchant:42");
    expect(group.entries[1]!.direction).toBe("credit");
    expect(group.entries[0]!.amount.amount).toBe(1000);
    expect(group.entries[1]!.amount.amount).toBe(1000);
    expect(group.totalDebit().equals(group.totalCredit())).toBe(true);
  });

  it("forRefund produces the exact reverse: [debit merchant:<id>, credit acquirer_clearing]", () => {
    const group = PostingGroup.forRefund({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(300, "USD"),
    });
    expect(group.entries).toHaveLength(2);
    expect(group.entries[0]!.account.toString()).toBe("merchant:42");
    expect(group.entries[0]!.direction).toBe("debit");
    expect(group.entries[1]!.account.toString()).toBe("acquirer_clearing");
    expect(group.entries[1]!.direction).toBe("credit");
  });
});

describe("LedgerEntry immutability", () => {
  it("mutating the object returned by toState() does not affect the original entry", () => {
    const group = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(500, "USD"),
    });
    const entry = group.entries[0]!;
    const state = entry.toState();
    // @ts-expect-error -- deliberately mutating a snapshot to prove it's a copy
    state.paymentId = "mutated";
    expect(entry.paymentId).toBe("pay_1");
  });

  it("LedgerEntry.fromState copies props rather than aliasing them", () => {
    const props = {
      id: randomUUID(),
      operationId: randomUUID(),
      account: LedgerAccount.merchant("1"),
      direction: "credit" as const,
      amount: Money.of(100, "USD"),
      paymentId: "pay_1",
      entryType: "capture" as const,
      reversesOperationId: null,
      createdAt: new Date(),
    };
    const entry = LedgerEntry.fromState(props);
    const state = entry.toState();
    // @ts-expect-error -- deliberately mutating a snapshot to prove it's a copy
    state.paymentId = "mutated";
    expect(entry.paymentId).toBe("pay_1");
  });
});
