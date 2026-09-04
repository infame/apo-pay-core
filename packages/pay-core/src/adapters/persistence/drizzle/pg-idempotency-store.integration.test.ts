import { describe, expect, it } from "vitest";
import { DuplicateIdempotencyKeyError } from "./errors.js";
import { PgIdempotencyStore } from "./pg-idempotency-store.js";
import { TransactionScope } from "./transaction-scope.js";
import { withTestDb } from "./test-support.js";

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)("PgIdempotencyStore (integration)", () => {
  if (!hasTestDb) return;

  const { pool } = withTestDb();
  const scope = new TransactionScope(pool);

  it("returns null on a miss", async () => {
    const store = new PgIdempotencyStore(scope, "create_payment");
    const found = await scope.run(() => store.find("missing-key"));
    expect(found).toBeNull();
  });

  it("save then find returns the same fingerprint and response snapshot", async () => {
    const store = new PgIdempotencyStore(scope, "create_payment");
    const createdAt = new Date("2026-01-01T00:00:00Z");

    await scope.run(() =>
      store.save({
        key: "key-1",
        requestFingerprint: "fp-1",
        response: { id: "pay_1", status: "authorized" },
        createdAt,
      }),
    );

    const found = await scope.run(() => store.find("key-1"));
    expect(found?.requestFingerprint).toBe("fp-1");
    expect(found?.response).toEqual({ id: "pay_1", status: "authorized" });
  });

  it("two stores with different operations don't collide on the same key", async () => {
    const createStore = new PgIdempotencyStore(scope, "create_payment");
    const captureStore = new PgIdempotencyStore(scope, "capture_payment");

    await scope.run(() =>
      createStore.save({
        key: "shared-key",
        requestFingerprint: "fp-create",
        response: { via: "create" },
        createdAt: new Date(),
      }),
    );
    await scope.run(() =>
      captureStore.save({
        key: "shared-key",
        requestFingerprint: "fp-capture",
        response: { via: "capture" },
        createdAt: new Date(),
      }),
    );

    const fromCreate = await scope.run(() => createStore.find("shared-key"));
    const fromCapture = await scope.run(() => captureStore.find("shared-key"));
    expect(fromCreate?.requestFingerprint).toBe("fp-create");
    expect(fromCapture?.requestFingerprint).toBe("fp-capture");
  });

  it("a second save of the same (key, operation) throws DuplicateIdempotencyKeyError, not a raw pg error", async () => {
    const store = new PgIdempotencyStore(scope, "refund_payment");
    await scope.run(() =>
      store.save({
        key: "dup-key",
        requestFingerprint: "fp-first",
        response: { attempt: 1 },
        createdAt: new Date(),
      }),
    );

    await expect(
      scope.run(() =>
        store.save({
          key: "dup-key",
          requestFingerprint: "fp-second",
          response: { attempt: 2 },
          createdAt: new Date(),
        }),
      ),
    ).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError);
  });
});
