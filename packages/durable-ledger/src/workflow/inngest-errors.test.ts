import {
  NonRetriableError,
  RetryAfterError,
  StepError,
  serializeError,
} from "inngest";
import { describe, expect, it } from "vitest";
import {
  inngestRetriesFor,
  permanentStepFailureMessage,
  rethrowForInngest,
  stepFailureOf,
  WorkflowStepFailedError,
} from "./inngest-errors.js";
import {
  DEFAULT_RETRY_POLICY,
  resolveRetryPolicy,
  type RetryRefusalReason,
} from "./retry-policy.js";
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

describe("WorkflowStepFailedError.code", () => {
  it("equals its reason", () => {
    const error = new WorkflowStepFailedError(
      "capture",
      "terminal_error",
      new Error("boom"),
    );
    expect(error.code).toBe("terminal_error");
    expect(error.code).toBe(error.reason);
  });
});

describe("stepFailureOf", () => {
  it("recovers (stepName, reason) from a live WorkflowStepFailedError thrown directly", () => {
    const error = new WorkflowStepFailedError(
      "capture",
      "terminal_error",
      new Error("declined"),
    );
    expect(stepFailureOf(error)).toEqual({
      stepName: "capture",
      reason: "terminal_error",
    });
  });

  it("recovers (stepName, reason) from the NonRetriableError rethrowForInngest itself throws, whose .cause is the WorkflowStepFailedError", () => {
    let thrown: unknown;
    try {
      rethrowForInngest("capture", declinedError(), 1);
    } catch (err) {
      thrown = err;
    }
    expect(stepFailureOf(thrown)).toEqual({
      stepName: "capture",
      reason: "terminal_error",
    });
  });

  it("recovers (stepName, reason) from a real Inngest StepError, whose custom fields do not survive serialization", () => {
    const original = new WorkflowStepFailedError(
      "capture",
      "terminal_error",
      new Error("declined"),
    );
    const nonRetriable = new NonRetriableError(
      permanentStepFailureMessage("capture", "terminal_error"),
      { cause: original },
    );
    const stepError = new StepError("capture", serializeError(nonRetriable));

    // Confirms the ADR-0009 finding this parsing logic depends on: custom
    // fields (including WorkflowStepFailedError.code) do NOT survive onto
    // the StepError or its .cause.
    expect(stepError.stepId).toBe("capture");
    expect(
      (stepError.cause as { code?: unknown } | undefined)?.code,
    ).toBeUndefined();
    expect((stepError as unknown as { code?: unknown }).code).toBeUndefined();

    expect(stepFailureOf(stepError)).toEqual({
      stepName: "capture",
      reason: "terminal_error",
    });
  });

  it("returns { stepName: undefined, reason: undefined } for a plain Error", () => {
    expect(stepFailureOf(new Error("boom"))).toEqual({
      stepName: undefined,
      reason: undefined,
    });
  });

  it("returns { stepName: undefined, reason: undefined } for non-Error values", () => {
    expect(stepFailureOf("boom")).toEqual({
      stepName: undefined,
      reason: undefined,
    });
    expect(stepFailureOf(undefined)).toEqual({
      stepName: undefined,
      reason: undefined,
    });
    expect(stepFailureOf(null)).toEqual({
      stepName: undefined,
      reason: undefined,
    });
  });

  it("round-trips every RetryRefusalReason through permanentStepFailureMessage", () => {
    const reasons: readonly RetryRefusalReason[] = [
      "terminal_error",
      "attempts_exhausted",
      "unclassified_error",
    ];
    for (const reason of reasons) {
      const error = new NonRetriableError(
        permanentStepFailureMessage("x", reason),
      );
      expect(stepFailureOf(error).reason).toBe(reason);
    }
  });
});
