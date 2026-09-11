import { NonRetriableError, RetryAfterError } from "inngest";
import { describe, expect, it } from "vitest";
import {
  inngestRetriesFor,
  rethrowForInngest,
  WorkflowStepFailedError,
} from "./inngest-errors.js";
import { DEFAULT_RETRY_POLICY, resolveRetryPolicy } from "./retry-policy.js";
import {
  PayCoreDeclinedError,
  PayCoreUnavailableError,
} from "../ports/pay-core-errors.js";

function unavailableError(retryAfterMs?: number): PayCoreUnavailableError {
  return new PayCoreUnavailableError(
    "pay-core unavailable",
    { operation: "capture_payment", status: 503, payCoreCode: "unavailable" },
    retryAfterMs,
  );
}

function declinedError(): PayCoreDeclinedError {
  return new PayCoreDeclinedError("declined", {
    operation: "capture_payment",
    status: 402,
    payCoreCode: "declined",
  });
}

describe("rethrowForInngest", () => {
  it("throws RetryAfterError with the decided delay, in seconds, for a retryable error", () => {
    const rng = () => 0; // pins the jittered delay to exp/2
    const policy = resolveRetryPolicy();
    let thrown: unknown;
    try {
      rethrowForInngest("capture", unavailableError(), 1, {
        policy,
        rng,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RetryAfterError);
    const retryAfterError = thrown as RetryAfterError;
    // exp = baseDelayMs * multiplier^0 = 500; jittered = exp/2 = 250 at rng()=0
    const expectedDelayMs = Math.round(policy.baseDelayMs / 2);
    expect(retryAfterError.retryAfter).toBe(
      String(Math.ceil(expectedDelayMs / 1000)),
    );
    expect(retryAfterError.cause).toBeInstanceOf(PayCoreUnavailableError);
  });

  it("throws NonRetriableError with reason terminal_error for a non-retryable PayCoreClientError", () => {
    let thrown: unknown;
    try {
      rethrowForInngest("capture", declinedError(), 1);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(NonRetriableError);
    const nonRetriable = thrown as NonRetriableError;
    expect(nonRetriable.cause).toBeInstanceOf(WorkflowStepFailedError);
    expect((nonRetriable.cause as WorkflowStepFailedError).reason).toBe(
      "terminal_error",
    );
  });

  it("throws NonRetriableError with reason unclassified_error for a non-PayCoreClientError error", () => {
    let thrown: unknown;
    try {
      rethrowForInngest("post-ledger", new Error("boom"), 1);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(NonRetriableError);
    const nonRetriable = thrown as NonRetriableError;
    expect(nonRetriable.cause).toBeInstanceOf(WorkflowStepFailedError);
    expect((nonRetriable.cause as WorkflowStepFailedError).reason).toBe(
      "unclassified_error",
    );
  });

  it("throws NonRetriableError with reason attempts_exhausted, distinguishable from terminal_error, once the policy's maxAttempts is reached", () => {
    const policy = resolveRetryPolicy();
    let thrown: unknown;
    try {
      rethrowForInngest("capture", unavailableError(), policy.maxAttempts, {
        policy,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(NonRetriableError);
    const nonRetriable = thrown as NonRetriableError;
    expect(nonRetriable.cause).toBeInstanceOf(WorkflowStepFailedError);
    expect((nonRetriable.cause as WorkflowStepFailedError).reason).toBe(
      "attempts_exhausted",
    );
  });

  it("honors a server Retry-After hint, quantized to whole seconds", () => {
    let thrown: unknown;
    try {
      rethrowForInngest("capture", unavailableError(5000), 1, {
        rng: () => 0,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RetryAfterError);
    expect((thrown as RetryAfterError).retryAfter).toBe("5");
  });
});

describe("inngestRetriesFor", () => {
  it("equals DEFAULT_RETRY_POLICY.maxAttempts - 1", () => {
    expect(inngestRetriesFor(DEFAULT_RETRY_POLICY)).toBe(3);
    expect(inngestRetriesFor(DEFAULT_RETRY_POLICY)).toBe(
      DEFAULT_RETRY_POLICY.maxAttempts - 1,
    );
  });

  it("throws when maxAttempts - 1 falls outside Inngest's 0-20 range", () => {
    expect(() =>
      inngestRetriesFor({ ...DEFAULT_RETRY_POLICY, maxAttempts: 22 }),
    ).toThrow();
    // maxAttempts must be >= 1 (resolveRetryPolicy's own floor), so the only
    // reachable out-of-range case above 20 is the ceiling.
  });
});
