import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Money } from "../../../domain/money.js";
import { Payment } from "../../../domain/payment.js";
import { OptimisticLockError } from "./errors.js";
import { paymentEvents, payments } from "./schema.js";
import { PgPaymentRepository } from "./pg-payment-repository.js";
import { TransactionScope } from "./transaction-scope.js";
import { withTestDb } from "./test-support.js";

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Real-Postgres suite. Skipped (not silently — see `test-support.ts`) unless
 * `TEST_DATABASE_URL` is set; `pnpm test` never picks this file up at all
 * (`vitest.config.ts` excludes `*.integration.test.ts`), so this guard only
 * matters for a direct/misconfigured invocation.
 */
describe.skipIf(!hasTestDb)("PgPaymentRepository (integration)", () => {
  if (!hasTestDb) return;

  const { db, pool } = withTestDb();
  const scope = new TransactionScope(pool);
  const repo = new PgPaymentRepository(scope);

  it("round-trips create → authorize → capture, preserving status/amounts/providerRef/timestamps", async () => {
    const id = randomUUID();
    const payment = Payment.create({ id, amount: Money.of(1000, "USD") });
    payment.authorize("prov_ref_1");
    payment.capture(Money.of(600, "USD"));
    const events = payment.pullEvents();

    await scope.run(() => repo.save(payment, events));

    const loaded = await scope.run(() => repo.findById(id));
    expect(loaded).not.toBeNull();
    expect(loaded?.status).toBe("captured");
    expect(loaded?.providerRef).toBe("prov_ref_1");
    expect(loaded?.amount.equals(Money.of(1000, "USD"))).toBe(true);
    expect(loaded?.capturedAmount.equals(Money.of(600, "USD"))).toBe(true);
    expect(loaded?.refundedAmount.isZero()).toBe(true);

    const state = loaded?.toState();
    expect(state?.failureReason).toBeNull();
    expect(state?.createdAt).toBeInstanceOf(Date);
    expect(state?.updatedAt).toBeInstanceOf(Date);

    const rows = await db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, id));
    expect(rows.map((r) => r.type).sort()).toEqual(
      ["payment.authorized", "payment.captured", "payment.created"].sort(),
    );
    const authorizedRow = rows.find((r) => r.type === "payment.authorized");
    expect(authorizedRow?.payload).toEqual({ providerRef: "prov_ref_1" });
    const capturedRow = rows.find((r) => r.type === "payment.captured");
    expect(capturedRow?.payload).toEqual({
      amount: { amount: 600, currency: "USD" },
    });
  });

  it("preserves failureReason for a failed payment", async () => {
    const id = randomUUID();
    const payment = Payment.create({ id, amount: Money.of(500, "USD") });
    payment.fail("insufficient_funds");
    await scope.run(() => repo.save(payment, payment.pullEvents()));

    const loaded = await scope.run(() => repo.findById(id));
    expect(loaded?.status).toBe("failed");
    expect(loaded?.toState().failureReason).toBe("insufficient_funds");
  });

  it("returns null for an unknown id", async () => {
    const loaded = await scope.run(() => repo.findById(randomUUID()));
    expect(loaded).toBeNull();
  });

  it("optimistic-lock conflict: a stale save loses the race with OptimisticLockError, version advances by exactly 1", async () => {
    const id = randomUUID();
    const seed = Payment.create({ id, amount: Money.of(500, "USD") });
    await scope.run(() => repo.save(seed, seed.pullEvents()));

    const loadedA = await scope.run(() => repo.findById(id));
    const loadedB = await scope.run(() => repo.findById(id));
    if (!loadedA || !loadedB) {
      throw new Error("setup failed: payment not found after seeding");
    }

    loadedA.authorize("ref_a");
    loadedB.authorize("ref_b");

    await scope.run(() => repo.save(loadedA, loadedA.pullEvents()));

    await expect(
      scope.run(() => repo.save(loadedB, loadedB.pullEvents())),
    ).rejects.toBeInstanceOf(OptimisticLockError);

    const rows = await db.select().from(payments).where(eq(payments.id, id));
    expect(rows[0]?.version).toBe(2);
    expect(rows[0]?.providerRef).toBe("ref_a");
  });

  it("rolls back the whole transaction when the run() callback throws after a write", async () => {
    const id = randomUUID();
    const payment = Payment.create({ id, amount: Money.of(750, "USD") });
    const events = payment.pullEvents();

    await expect(
      scope.run(async () => {
        await repo.save(payment, events);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await db.select().from(payments).where(eq(payments.id, id));
    expect(rows).toHaveLength(0);
    const eventRows = await db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, id));
    expect(eventRows).toHaveLength(0);
  });
});
