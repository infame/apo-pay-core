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

describe("PostingGroup.reversalOf", () => {
  it("mirrors a forCapture group exactly: same accounts/amounts/currency, directions flipped", () => {
    const original = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(1000, "USD"),
    });
    const reversal = PostingGroup.reversalOf({
      original: original.entries,
      operationId: opId(),
    });

    expect(reversal.entries).toHaveLength(2);
    expect(reversal.entries[0]!.account.toString()).toBe("acquirer_clearing");
    expect(reversal.entries[0]!.direction).toBe("credit");
    expect(reversal.entries[0]!.amount.amount).toBe(1000);
    expect(reversal.entries[1]!.account.toString()).toBe("merchant:42");
    expect(reversal.entries[1]!.direction).toBe("debit");
    expect(reversal.entries[1]!.amount.amount).toBe(1000);
  });

  it("stamps entryType: 'reversal' and reversesOperationId equal to the original's operationId on every entry", () => {
    const original = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(500, "USD"),
    });
    const reversal = PostingGroup.reversalOf({
      original: original.entries,
      operationId: opId(),
    });

    for (const entry of reversal.entries) {
      expect(entry.entryType).toBe("reversal");
      expect(entry.reversesOperationId).toBe(original.operationId);
    }
  });

  it("stamps the new operationId and mints fresh entry ids, not reusing the original entries' ids", () => {
    const original = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(500, "USD"),
    });
    const newOperationId = opId();
    const reversal = PostingGroup.reversalOf({
      original: original.entries,
      operationId: newOperationId,
    });

    expect(reversal.operationId).toBe(newOperationId);
    for (const entry of reversal.entries) {
      expect(entry.operationId).toBe(newOperationId);
    }
    const originalIds = new Set(original.entries.map((entry) => entry.id));
    for (const entry of reversal.entries) {
      expect(originalIds.has(entry.id)).toBe(false);
    }
  });

  it("the reversal is itself internally balanced", () => {
    const original = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(750, "USD"),
    });
    const reversal = PostingGroup.reversalOf({
      original: original.entries,
      operationId: opId(),
    });

    expect(reversal.totalDebit().equals(reversal.totalCredit())).toBe(true);
  });

  it("honors a passed now", () => {
    const original = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(500, "USD"),
    });
    const now = new Date("2026-02-02T00:00:00.000Z");
    const reversal = PostingGroup.reversalOf({
      original: original.entries,
      operationId: opId(),
      now,
    });

    for (const entry of reversal.entries) {
      expect(entry.createdAt).toEqual(now);
    }
  });

  it("throws InvalidLedgerEntryError on an empty original array", () => {
    expect(() =>
      PostingGroup.reversalOf({ original: [], operationId: opId() }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("throws InvalidLedgerEntryError when original entries have mixed operationIds", () => {
    const first = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(500, "USD"),
    });
    const second = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(500, "USD"),
    });
    expect(() =>
      PostingGroup.reversalOf({
        original: [first.entries[0]!, second.entries[1]!],
        operationId: opId(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("throws InvalidLedgerEntryError when original entries have mixed paymentIds", () => {
    const operationId = opId();
    const first = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(500, "USD"),
    });
    // A hand-built second entry sharing the same operationId but a
    // different paymentId — not producible via forCapture/create together,
    // so constructed directly via fromState to simulate a corrupt/mixed
    // stored result.
    const mismatched = LedgerEntry.fromState({
      ...first.entries[1]!.toState(),
      paymentId: "pay_2",
    });
    expect(() =>
      PostingGroup.reversalOf({
        original: [first.entries[0]!, mismatched],
        operationId: opId(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("throws InvalidLedgerEntryError when params.operationId equals the original's operationId", () => {
    const original = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(500, "USD"),
    });
    expect(() =>
      PostingGroup.reversalOf({
        original: original.entries,
        operationId: original.operationId,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("throws InvalidLedgerEntryError when an original entry already has entryType: 'reversal'", () => {
    const original = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(500, "USD"),
    });
    const reversal = PostingGroup.reversalOf({
      original: original.entries,
      operationId: opId(),
    });
    expect(() =>
      PostingGroup.reversalOf({
        original: reversal.entries,
        operationId: opId(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("throws InvalidLedgerEntryError on a non-UUID params.operationId", () => {
    const original = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "42",
      amount: Money.of(500, "USD"),
    });
    expect(() =>
      PostingGroup.reversalOf({
        original: original.entries,
        operationId: "not-a-uuid",
      }),
    ).toThrow(InvalidLedgerEntryError);
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
