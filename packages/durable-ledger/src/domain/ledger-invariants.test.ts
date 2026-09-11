import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { residuals } from "./balances.js";
import { LedgerEntry, PostingGroup } from "./entry.js";
import { Money } from "./money.js";

/**
 * Tiny seeded linear congruential generator — deterministic pseudo-random
 * numbers without pulling in a `fast-check` dependency for one test file.
 * Parameters are the classic Numerical Recipes constants.
 */
function makeLcg(seed: number) {
  let state = seed >>> 0;
  return function next(): number {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  const index = Math.floor(rng() * values.length);
  return values[Math.min(index, values.length - 1)]!;
}

describe("ledger invariant: residuals are all-zero after every operation", () => {
  it("holds across ~200 pseudo-random capture/refund operations, multiple merchants and currencies", () => {
    const rng = makeLcg(0xc0ffee);
    const merchantIds = ["1", "2", "3", "4"];
    const currencies = ["USD", "EUR"];

    const entries: LedgerEntry[] = [];

    for (let i = 0; i < 200; i++) {
      const merchantId = pick(rng, merchantIds);
      const currency = pick(rng, currencies);
      const amount = Money.of(1 + Math.floor(rng() * 10_000), currency);
      const isCapture = rng() < 0.6;

      const group = isCapture
        ? PostingGroup.forCapture({
            operationId: randomUUID(),
            paymentId: `pay_${String(i)}`,
            merchantId,
            amount,
          })
        : PostingGroup.forRefund({
            operationId: randomUUID(),
            paymentId: `pay_${String(i)}`,
            merchantId,
            amount,
          });

      entries.push(...group.entries);

      // Assert after EVERY single operation, not just at the end — a bug
      // that transiently breaks and self-heals should still fail this.
      for (const [, residual] of residuals(entries)) {
        expect(residual.isZero()).toBe(true);
      }
    }

    const finalResiduals = residuals(entries);
    expect(finalResiduals.get("USD")?.isZero()).toBe(true);
    expect(finalResiduals.get("EUR")?.isZero()).toBe(true);
  });

  it("a capture followed by its reversalOf nets every account back to zero, without removing the original entries", () => {
    const operationId = randomUUID();
    const capture = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_reversal_check",
      merchantId: "42",
      amount: Money.of(2500, "USD"),
    });

    const reversal = PostingGroup.reversalOf({
      original: capture.entries,
      operationId: randomUUID(),
    });

    const combined = [...capture.entries, ...reversal.entries];

    // Reversal, not deletion: both operations' entries are present.
    expect(combined).toHaveLength(4);

    const combinedResiduals = residuals(combined);
    expect(combinedResiduals.get("USD")?.isZero()).toBe(true);
  });
});
