import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryLedgerRepository } from "./in-memory-ledger-repository.js";
import { PostingGroup } from "../../domain/entry.js";
import { LedgerAccount } from "../../domain/account.js";
import { Money } from "../../domain/money.js";
import { balanceOf } from "../../domain/balances.js";
import { PostingConflictError } from "../../ports/ledger-repository.js";

function captureGroup(overrides?: {
  operationId?: string;
  paymentId?: string;
  merchantId?: string;
  amount?: Money;
}): PostingGroup {
  return PostingGroup.forCapture({
    operationId: overrides?.operationId ?? randomUUID(),
    paymentId: overrides?.paymentId ?? "payment-1",
    merchantId: overrides?.merchantId ?? "merchant-1",
    amount: overrides?.amount ?? Money.of(1000, "USD"),
  });
}

describe("InMemoryLedgerRepository", () => {
  it("posts a forCapture group and round-trips via findByOperationId", async () => {
    const repo = new InMemoryLedgerRepository();
    const group = captureGroup();

    const result = await repo.post(group);
    expect(result.outcome).toBe("posted");

    const found = await repo.findByOperationId(group.operationId);
    expect(found).toHaveLength(2);
    expect(found.map((e) => e.direction).sort()).toEqual(["credit", "debit"]);
  });

  it("is idempotent on re-posting the identical group", async () => {
    const repo = new InMemoryLedgerRepository();
    const operationId = randomUUID();
    const group1 = captureGroup({ operationId });
    const group2 = captureGroup({ operationId });

    const first = await repo.post(group1);
    const second = await repo.post(group2);

    expect(first.outcome).toBe("posted");
    expect(second.outcome).toBe("already_posted");
    // Same STORED entries (first call's), not the second caller's own input.
    expect(second.entries.map((e) => e.id).sort()).toEqual(
      first.entries.map((e) => e.id).sort(),
    );

    const stored = await repo.findByOperationId(operationId);
    expect(stored).toHaveLength(2); // no duplicate rows
  });

  it("throws PostingConflictError when a DIFFERENT group is posted under the same operationId", async () => {
    const repo = new InMemoryLedgerRepository();
    const operationId = randomUUID();
    const group1 = captureGroup({ operationId, amount: Money.of(1000, "USD") });
    const group2 = captureGroup({ operationId, amount: Money.of(2000, "USD") });

    await repo.post(group1);
    await expect(repo.post(group2)).rejects.toBeInstanceOf(
      PostingConflictError,
    );
  });

  it("getBalance agrees with balanceOf(findByAccount(...)), including the acquirer_clearing negative-sign convention", async () => {
    const repo = new InMemoryLedgerRepository();
    await repo.post(captureGroup({ amount: Money.of(1500, "USD") }));

    const clearing = LedgerAccount.acquirerClearing();
    const merchant = LedgerAccount.merchant("merchant-1");

    const clearingBalance = await repo.getBalance(clearing, "USD");
    const merchantBalance = await repo.getBalance(merchant, "USD");

    expect(clearingBalance.equals(Money.of(-1500, "USD"))).toBe(true);
    expect(merchantBalance.equals(Money.of(1500, "USD"))).toBe(true);

    expect(
      clearingBalance.equals(
        balanceOf(await repo.findByAccount(clearing, "USD"), clearing, "USD"),
      ),
    ).toBe(true);
    expect(
      merchantBalance.equals(
        balanceOf(await repo.findByAccount(merchant, "USD"), merchant, "USD"),
      ),
    ).toBe(true);
  });

  it("findByPaymentId returns entries across multiple operations for one payment", async () => {
    const repo = new InMemoryLedgerRepository();
    const paymentId = "payment-shared";

    await repo.post(captureGroup({ paymentId, amount: Money.of(500, "USD") }));
    await repo.post(captureGroup({ paymentId, amount: Money.of(700, "USD") }));
    await repo.post(captureGroup({ paymentId: "other-payment" }));

    const entries = await repo.findByPaymentId(paymentId);
    expect(entries).toHaveLength(4); // 2 operations x 2 entries each
    expect(entries.every((e) => e.paymentId === paymentId)).toBe(true);
  });
});
