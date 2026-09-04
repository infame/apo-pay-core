import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPayCore, type PayCore } from "../../../composition-root.js";
import type { CreatePaymentResult } from "../../../app/create-payment.js";
import type { RefundPaymentResult } from "../../../app/refund-payment.js";
import { MockProvider } from "../../mock/mock-provider.js";
import { OptimisticLockError } from "./errors.js";
import { idempotencyKeys, paymentEvents, payments } from "./schema.js";
import { testDatabaseUrl, withTestDb } from "./test-support.js";

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Drives `createPayCore`'s wired use-cases (not the adapters directly) —
 * this is the suite that proves the concurrency story end to end: idempotent
 * requests collapse to one effect, and racing mutations on one payment lose
 * cleanly to `OptimisticLockError` rather than corrupting the money
 * invariant.
 */
describe.skipIf(!hasTestDb)("createPayCore concurrency (integration)", () => {
  if (!hasTestDb) return;

  const { db } = withTestDb();

  function newCore(): PayCore {
    return createPayCore({
      databaseUrl: testDatabaseUrl(),
      provider: new MockProvider(),
      clock: () => new Date("2026-01-01T00:00:00Z"),
    });
  }

  it("idempotency race: two identical createPayment calls collapse to one effect", async () => {
    const core = newCore();
    try {
      const key = `race-${randomUUID()}`;
      const cmd = {
        amount: 1500,
        currency: "USD",
        paymentMethodToken: "tok_visa",
        idempotencyKey: key,
      };

      const results = await Promise.allSettled([
        core.createPayment(cmd),
        core.createPayment(cmd),
      ]);

      // Negative control: if idempotency didn't work, this would be 2
      // fulfilled results with 2 different payment ids.
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<CreatePaymentResult> =>
          r.status === "fulfilled",
      );
      expect(fulfilled).toHaveLength(2);
      const ids = new Set(fulfilled.map((r) => r.value.id));
      expect(ids.size).toBe(1);

      const allPayments = await db.select().from(payments);
      const allKeys = await db.select().from(idempotencyKeys);
      expect(allPayments).toHaveLength(1);
      expect(allKeys).toHaveLength(1);
    } finally {
      await core.close();
    }
  });

  it("concurrent mutation: N racing refunds on one payment respect the money invariant", async () => {
    const core = newCore();
    try {
      const created = await core.createPayment({
        amount: 10_000,
        currency: "USD",
        paymentMethodToken: "tok_visa",
        idempotencyKey: `create-${randomUUID()}`,
      });
      await core.capturePayment({
        paymentId: created.id,
        idempotencyKey: `capture-${randomUUID()}`,
      });

      // Amounts evenly divide the captured total: any single valid refund
      // step (read-then-refund) can never locally exceed the cap no matter
      // how many prior commits it happens to observe, so a rejection here is
      // guaranteed to be the optimistic-lock conflict this test targets, not
      // a (also-legitimate, but different) domain AmountExceededError.
      const attempts = 10;
      const perAttempt = 1000; // 10 × 1000 = 10 000 == captured amount exactly.
      const results = await Promise.allSettled(
        Array.from({ length: attempts }, () =>
          core.refundPayment({
            paymentId: created.id,
            amount: perAttempt,
            idempotencyKey: `refund-${randomUUID()}`,
          }),
        ),
      );

      const successes = results.filter(
        (r): r is PromiseFulfilledResult<RefundPaymentResult> =>
          r.status === "fulfilled",
      );
      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );

      expect(successes.length).toBeGreaterThan(0);
      const refundedTotal = successes.length * perAttempt;
      expect(refundedTotal).toBeLessThanOrEqual(10_000);
      for (const failure of failures) {
        expect(failure.reason).toBeInstanceOf(OptimisticLockError);
      }

      const rows = await db.select().from(payments);
      const finalRow = rows.find((r) => r.id === created.id);
      expect(finalRow).toBeDefined();
      if (finalRow) {
        expect(
          finalRow.amountCaptured - finalRow.amountRefunded,
        ).toBeGreaterThanOrEqual(0);
        expect(finalRow.amountCaptured).toBeLessThanOrEqual(
          finalRow.amountAuthorized,
        );
        expect(finalRow.amountRefunded).toBeGreaterThanOrEqual(0);
        expect(finalRow.amountRefunded).toBe(refundedTotal);
      }
    } finally {
      await core.close();
    }
  });

  it("~50 interleaved create/capture/refund ops leave every row invariant-safe and events matching successes", async () => {
    const core = newCore();
    try {
      const createCount = 16;
      const createResults = await Promise.allSettled(
        Array.from({ length: createCount }, (_, i) =>
          core.createPayment({
            amount: 4000,
            currency: "USD",
            paymentMethodToken: "tok_visa",
            idempotencyKey: `bulk-create-${i}-${randomUUID()}`,
          }),
        ),
      );
      const created = createResults
        .filter(
          (r): r is PromiseFulfilledResult<CreatePaymentResult> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value.id);
      expect(created.length).toBe(createCount); // amount doesn't trigger the mock decline hook

      const captureResults = await Promise.allSettled(
        created.map((id) =>
          core.capturePayment({
            paymentId: id,
            idempotencyKey: `bulk-capture-${id}`,
          }),
        ),
      );
      const captured = created.filter(
        (_, i) => captureResults[i]?.status === "fulfilled",
      );
      expect(captured.length).toBe(createCount); // one capture per payment, no contention across ids

      // Two racing refund attempts per captured payment: interleaved, some win, some lose.
      const refundResults = await Promise.allSettled(
        captured.flatMap((id) => [
          core.refundPayment({
            paymentId: id,
            amount: 1000,
            idempotencyKey: `bulk-refund-a-${id}`,
          }),
          core.refundPayment({
            paymentId: id,
            amount: 1000,
            idempotencyKey: `bulk-refund-b-${id}`,
          }),
        ]),
      );
      const successfulRefunds = refundResults.filter(
        (r) => r.status === "fulfilled",
      ).length;

      const totalOps = createCount + captured.length + refundResults.length;
      expect(totalOps).toBeGreaterThanOrEqual(48);

      const allRows = await db.select().from(payments);
      for (const row of allRows) {
        expect(row.amountCaptured - row.amountRefunded).toBeGreaterThanOrEqual(
          0,
        );
        expect(row.amountCaptured).toBeLessThanOrEqual(row.amountAuthorized);
        expect(row.amountRefunded).toBeGreaterThanOrEqual(0);
      }

      const expectedEvents =
        createCount * 2 + captured.length * 1 + successfulRefunds * 1;
      const eventRows = await db.select().from(paymentEvents);
      expect(eventRows).toHaveLength(expectedEvents);
    } finally {
      await core.close();
    }
  });
});
