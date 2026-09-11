import { describe, expect, it } from "vitest";
import { LedgerImbalanceError } from "../domain/errors.js";
import type { PayCoreErrorContext } from "../ports/pay-core-errors.js";
import {
  PayCoreBadRequestError,
  PayCoreClientError,
  PayCoreDeclinedError,
  PayCoreIdempotencyConflictError,
  PayCoreIllegalStateError,
  PayCoreMalformedResponseError,
  PayCoreNetworkError,
  PayCoreNotFoundError,
  PayCoreRequestCanceledError,
  PayCoreTimeoutError,
  PayCoreUnavailableError,
  PayCoreUnexpectedResponseError,
} from "../ports/pay-core-errors.js";
import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  decideRetry,
  isRetryable,
  resolveRetryPolicy,
  retryAfterMsOf,
} from "./retry-policy.js";

/**
 * Tiny seeded linear congruential generator — deterministic pseudo-random
 * numbers without pulling in a `fast-check` dependency for one test file.
 * Copied from `src/domain/ledger-invariants.test.ts` per this package's
 * convention of duplicating this small helper rather than sharing it.
 */
function makeLcg(seed: number) {
  let state = seed >>> 0;
  return function next(): number {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function ctx(): PayCoreErrorContext {
  return {
    operation: "capture_payment",
    status: 503,
    payCoreCode: "provider_unavailable",
  };
}

/** Pins that `retryAfterMsOf` is structural, not hardcoded to `PayCoreUnavailableError`. */
class FutureHintError extends PayCoreClientError {
  readonly code = "future_hint_error";
  readonly retryable = true;
  readonly retryAfterMs = 7000;
}

describe("isRetryable", () => {
  it.each([
    ["PayCoreNetworkError", new PayCoreNetworkError("boom", ctx())],
    ["PayCoreTimeoutError", new PayCoreTimeoutError("boom", ctx(), 10_000)],
    ["PayCoreUnavailableError", new PayCoreUnavailableError("boom", ctx())],
  ])("%s -> true", (_name, error) => {
    expect(isRetryable(error)).toBe(true);
  });

  it.each([
    [
      "PayCoreRequestCanceledError",
      new PayCoreRequestCanceledError("boom", ctx()),
    ],
    ["PayCoreBadRequestError", new PayCoreBadRequestError("boom", ctx())],
    ["PayCoreDeclinedError", new PayCoreDeclinedError("boom", ctx())],
    ["PayCoreNotFoundError", new PayCoreNotFoundError("boom", ctx())],
    [
      "PayCoreIdempotencyConflictError",
      new PayCoreIdempotencyConflictError("boom", ctx()),
    ],
    ["PayCoreIllegalStateError", new PayCoreIllegalStateError("boom", ctx())],
    [
      "PayCoreMalformedResponseError",
      new PayCoreMalformedResponseError("boom", ctx()),
    ],
  ])("%s -> false", (_name, error) => {
    expect(isRetryable(error)).toBe(false);
  });

  it.each([500, 502, 503, 429, 408])(
    "PayCoreUnexpectedResponseError with status %d -> true",
    (status) => {
      const error = new PayCoreUnexpectedResponseError("boom", {
        ...ctx(),
        status,
      });
      expect(isRetryable(error)).toBe(true);
    },
  );

  it.each([418, 451])(
    "PayCoreUnexpectedResponseError with status %d -> false",
    (status) => {
      const error = new PayCoreUnexpectedResponseError("boom", {
        ...ctx(),
        status,
      });
      expect(isRetryable(error)).toBe(false);
    },
  );

  it("PayCoreUnexpectedResponseError with status undefined -> false", () => {
    const error = new PayCoreUnexpectedResponseError("boom", {
      ...ctx(),
      status: undefined,
    });
    expect(isRetryable(error)).toBe(false);
  });

  it("returns false for a plain Error, a LedgerError, and non-error values, including a duck-typed object", () => {
    expect(isRetryable(new Error("boom"))).toBe(false);
    expect(isRetryable(new LedgerImbalanceError(new Map()))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable("boom")).toBe(false);
    expect(isRetryable({ retryable: true })).toBe(false);
  });
});

describe("decideRetry — classification", () => {
  it("a retryable error on attempt 1 with default policy -> shouldRetry: true with a delayMs", () => {
    const decision = decideRetry(new PayCoreUnavailableError("boom", ctx()), 1);
    expect(decision.shouldRetry).toBe(true);
    expect(decision.shouldRetry && decision.delayMs).toBeGreaterThan(0);
  });

  it("PayCoreDeclinedError -> terminal_error", () => {
    const decision = decideRetry(new PayCoreDeclinedError("boom", ctx()), 1);
    expect(decision).toMatchObject({
      shouldRetry: false,
      reason: "terminal_error",
    });
  });

  it.each([
    ["PayCoreIllegalStateError", new PayCoreIllegalStateError("boom", ctx())],
    [
      "PayCoreIdempotencyConflictError",
      new PayCoreIdempotencyConflictError("boom", ctx()),
    ],
  ])("%s -> terminal_error", (_name, error) => {
    const decision = decideRetry(error, 1);
    expect(decision).toMatchObject({
      shouldRetry: false,
      reason: "terminal_error",
    });
  });

  it("a plain Error -> unclassified_error", () => {
    const decision = decideRetry(new Error("boom"), 1);
    expect(decision).toMatchObject({
      shouldRetry: false,
      reason: "unclassified_error",
    });
  });

  it("precedence: a terminal error at attempt === maxAttempts is still terminal_error, not attempts_exhausted", () => {
    const decision = decideRetry(
      new PayCoreDeclinedError("boom", ctx()),
      DEFAULT_RETRY_POLICY.maxAttempts,
    );
    expect(decision).toMatchObject({
      shouldRetry: false,
      reason: "terminal_error",
    });
  });

  it("precedence: a plain Error at attempt === maxAttempts is still unclassified_error, not attempts_exhausted", () => {
    const decision = decideRetry(
      new Error("boom"),
      DEFAULT_RETRY_POLICY.maxAttempts,
    );
    expect(decision).toMatchObject({
      shouldRetry: false,
      reason: "unclassified_error",
    });
  });
});

describe("decideRetry — max attempts ceiling", () => {
  it("a retryable error at attempt === maxAttempts -> attempts_exhausted", () => {
    const decision = decideRetry(
      new PayCoreUnavailableError("boom", ctx()),
      DEFAULT_RETRY_POLICY.maxAttempts,
    );
    expect(decision).toMatchObject({
      shouldRetry: false,
      reason: "attempts_exhausted",
    });
  });

  it("the same error at attempt === maxAttempts - 1 -> shouldRetry: true (fencepost)", () => {
    const decision = decideRetry(
      new PayCoreUnavailableError("boom", ctx()),
      DEFAULT_RETRY_POLICY.maxAttempts - 1,
    );
    expect(decision.shouldRetry).toBe(true);
  });

  it("attempt > maxAttempts -> still attempts_exhausted, no throw", () => {
    const decision = decideRetry(
      new PayCoreUnavailableError("boom", ctx()),
      DEFAULT_RETRY_POLICY.maxAttempts + 5,
    );
    expect(decision).toMatchObject({
      shouldRetry: false,
      reason: "attempts_exhausted",
    });
  });

  it("maxAttempts: 1 -> a retryable error on attempt 1 is already exhausted", () => {
    const decision = decideRetry(
      new PayCoreUnavailableError("boom", ctx()),
      1,
      {
        policy: { maxAttempts: 1 },
      },
    );
    expect(decision).toMatchObject({
      shouldRetry: false,
      reason: "attempts_exhausted",
    });
  });

  it.each([0, -1, 1.5, Number.NaN])("attempt %p throws", (attempt) => {
    expect(() =>
      decideRetry(new PayCoreUnavailableError("boom", ctx()), attempt),
    ).toThrow();
  });

  it.each([
    ["baseDelayMs: 0", { baseDelayMs: 0 }],
    ["maxDelayMs < baseDelayMs", { maxDelayMs: 100, baseDelayMs: 500 }],
    ["backoffMultiplier: 0.5", { backoffMultiplier: 0.5 }],
    ["maxAttempts: 0", { maxAttempts: 0 }],
  ])(
    "resolveRetryPolicy throws on an incoherent policy (%s)",
    (_label, overrides) => {
      expect(() => resolveRetryPolicy(overrides)).toThrow();
    },
  );
});

describe("backoffDelayMs — growth and bounds", () => {
  const policy = {
    baseDelayMs: 500,
    backoffMultiplier: 2,
    maxDelayMs: 30_000,
    maxAttempts: 100,
  };

  it("rng: () => 0 (worst case) yields exactly 250, 500, 1000, 2000 for attempts 1..4", () => {
    const expected = [250, 500, 1000, 2000];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const { delayMs } = backoffDelayMs(attempt, policy, () => 0);
      expect(delayMs).toBe(expected[attempt - 1]);
    }
  });

  it("rng: () => 0.999999 (upper edge) approaches but never exceeds the unjittered exponential", () => {
    // rng < 1 keeps the raw jitter strictly below `exp`, but Math.round can
    // round a value like 499.9997 up to the boundary itself — so the bound
    // here is <=, not <; the exclusivity is on the pre-rounding jitter, not
    // on the rounded output.
    const exp = [500, 1000, 2000, 4000];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const { delayMs } = backoffDelayMs(attempt, policy, () => 0.999999);
      expect(delayMs).toBeLessThanOrEqual(exp[attempt - 1]!);
      expect(delayMs).toBeGreaterThanOrEqual(exp[attempt - 1]! / 2);
    }
  });

  it("delays are monotonically non-decreasing across attempts 1..10 under a fixed rng", () => {
    let previous = 0;
    for (let attempt = 1; attempt <= 10; attempt++) {
      const { delayMs } = backoffDelayMs(attempt, policy, () => 0.5);
      expect(delayMs).toBeGreaterThanOrEqual(previous);
      previous = delayMs;
    }
  });

  it("the cap binds at a high attempt count with no NaN/Infinity", () => {
    // At attempt 20, `exp` itself is already capped at maxDelayMs — but the
    // jittered result still only ranges [exp/2, exp), so with rng: () => 0.5
    // delayMs lands at maxDelayMs*0.75, not maxDelayMs exactly. Prove the cap
    // bound (never exceeds) and that growth has actually stopped (attempts 20
    // and 21 agree under the same fixed rng), rather than asserting equality
    // to maxDelayMs, which only rng -> 1 would produce.
    const a20 = backoffDelayMs(20, policy, () => 0.5);
    const a21 = backoffDelayMs(21, policy, () => 0.5);
    expect(a20.delayMs).toBeLessThanOrEqual(policy.maxDelayMs);
    expect(a20.delayMs).toBe(a21.delayMs);
    expect(Number.isFinite(a20.delayMs)).toBe(true);

    const { delayMs: atRngOne } = backoffDelayMs(20, policy, () => 0.999999);
    expect(atRngOne).toBe(policy.maxDelayMs);
  });

  it("seeded-LCG sweep: 1000 samples across attempts 1..8 stay within [baseDelayMs/2, maxDelayMs], are integers, never negative", () => {
    const rng = makeLcg(0xc0ffee);
    for (let i = 0; i < 1000; i++) {
      const attempt = 1 + Math.floor(rng() * 8);
      const { delayMs } = backoffDelayMs(attempt, policy, rng);
      expect(delayMs).toBeGreaterThanOrEqual(policy.baseDelayMs / 2);
      expect(delayMs).toBeLessThanOrEqual(policy.maxDelayMs);
      expect(Number.isInteger(delayMs)).toBe(true);
      expect(delayMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("a misbehaving rng (-5, 5, NaN) still yields a delay within bounds (clamp guard)", () => {
    for (const bad of [-5, 5, Number.NaN]) {
      const { delayMs } = backoffDelayMs(3, policy, () => bad);
      expect(delayMs).toBeGreaterThanOrEqual(policy.baseDelayMs);
      expect(delayMs).toBeLessThanOrEqual(policy.maxDelayMs);
    }
  });

  it("reproducibility: two calls with identically-seeded LCGs produce identical delayMs sequences", () => {
    const rngA = makeLcg(0xc0ffee);
    const rngB = makeLcg(0xc0ffee);
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(backoffDelayMs(attempt, policy, rngA).delayMs).toBe(
        backoffDelayMs(attempt, policy, rngB).delayMs,
      );
    }
  });
});

describe("decideRetry — server-supplied Retry-After", () => {
  it("retryAfterMs: 5000 on attempt 1 dominates the ~250-500ms backoff", () => {
    const error = new PayCoreUnavailableError("boom", ctx(), 5000);
    const decision = decideRetry(error, 1);
    expect(decision).toMatchObject({
      shouldRetry: true,
      delayMs: 5000,
      source: "server_hint",
    });
  });

  it("retryAfterMs: 100 on attempt 4 loses to the escalated backoff", () => {
    const error = new PayCoreUnavailableError("boom", ctx(), 100);
    const decision = decideRetry(error, 4, { policy: { maxAttempts: 10 } });
    expect(decision.shouldRetry).toBe(true);
    if (decision.shouldRetry) {
      expect(decision.source).toBe("backoff");
      expect(decision.delayMs).toBeGreaterThanOrEqual(2000);
    }
  });

  it("retryAfterMs: 0 falls back to normal backoff, never exactly 0", () => {
    const error = new PayCoreUnavailableError("boom", ctx(), 0);
    const decision = decideRetry(error, 1);
    expect(decision.shouldRetry).toBe(true);
    if (decision.shouldRetry) {
      expect(decision.delayMs).toBeGreaterThanOrEqual(250);
      expect(decision.delayMs).not.toBe(0);
    }
  });

  it("retryAfterMs: 86_400_000 is clamped to maxDelayMs", () => {
    const error = new PayCoreUnavailableError("boom", ctx(), 86_400_000);
    const decision = decideRetry(error, 1);
    expect(decision).toMatchObject({
      shouldRetry: true,
      delayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
      source: "server_hint",
    });
  });

  it("a negative retryAfterMs is ignored, normal backoff computed", () => {
    const error = new PayCoreUnavailableError("boom", ctx(), -100);
    const decision = decideRetry(error, 1);
    expect(decision.shouldRetry).toBe(true);
    if (decision.shouldRetry) {
      expect(decision.source).toBe("backoff");
    }
  });

  it("no retryAfterMs at all -> source: backoff", () => {
    const decision = decideRetry(new PayCoreUnavailableError("boom", ctx()), 1);
    expect(decision.shouldRetry).toBe(true);
    if (decision.shouldRetry) {
      expect(decision.source).toBe("backoff");
    }
  });

  it("a future PayCoreClientError subclass carrying retryAfterMs is honored structurally", () => {
    const decision = decideRetry(new FutureHintError("boom", ctx()), 1);
    expect(decision).toMatchObject({
      shouldRetry: true,
      delayMs: 7000,
      source: "server_hint",
    });
  });

  it("retryAfterMsOf returns undefined for a non-PayCoreClientError object, even one shaped like it", () => {
    expect(
      retryAfterMsOf({ retryAfterMs: 5000, retryable: true }),
    ).toBeUndefined();
  });
});

describe("DEFAULT_RETRY_POLICY", () => {
  it("smoke test: decideRetry with no options at all", () => {
    const decision = decideRetry(new PayCoreUnavailableError("boom", ctx()), 1);
    expect(decision.shouldRetry).toBe(true);
    if (decision.shouldRetry) {
      expect(decision.delayMs).toBeGreaterThanOrEqual(250);
      expect(decision.delayMs).toBeLessThanOrEqual(500);
    }
  });

  it("resolveRetryPolicy() deep-equals DEFAULT_RETRY_POLICY; overrides apply only the given key", () => {
    expect(resolveRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
    expect(resolveRetryPolicy({ maxAttempts: 7 })).toEqual({
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: 7,
    });
  });

  it("worst-case wall-clock across the default attempt budget stays under 4s", () => {
    let total = 0;
    for (
      let attempt = 1;
      attempt < DEFAULT_RETRY_POLICY.maxAttempts;
      attempt++
    ) {
      total += backoffDelayMs(
        attempt,
        DEFAULT_RETRY_POLICY,
        () => 0.999999,
      ).delayMs;
    }
    expect(total).toBeLessThan(4000);
  });
});
