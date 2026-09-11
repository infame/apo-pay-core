import { NonRetriableError } from "inngest";
import { describe, expect, it } from "vitest";
import { runPaymentExecute } from "./payment-execute.js";
import { FakeWorkflowStep } from "./fake-workflow-step.js";
import {
  authorizedPaymentResponse,
  capturedPaymentResponse,
  declinedAtAuthorizeResponse,
  FakePayCoreClient,
} from "./fake-pay-core-client.js";
import { InMemoryLedgerRepository } from "../adapters/memory/in-memory-ledger-repository.js";
import { paymentExecuteRequestedSchema } from "./events.js";
import {
  PayCoreBadRequestError,
  PayCoreDeclinedError,
  PayCoreIllegalStateError,
} from "../ports/pay-core-errors.js";
import { PostingConflictError } from "../ports/ledger-repository.js";
import {
  WorkflowStepFailedError,
  permanentStepFailureMessage,
} from "./inngest-errors.js";
import { NEEDS_REVIEW_MARKER } from "./compensation.js";
import type { RetryRefusalReason } from "./retry-policy.js";

/**
 * `InngestTestEngine` (see `payment-execute.test.ts`'s header comment)
 * cannot execute any handler code after a step fails, so it cannot observe
 * this package's compensation path at all. This file drives
 * `runPaymentExecute` directly against `FakeWorkflowStep`
 * (`./fake-workflow-step.js`) instead — the whole point of that seam (see
 * `docs/adr/0009-compensation-routing-and-the-workflow-step-seam.md`).
 *
 * `FakeWorkflowStep.scriptFailure(stepId, error)` pre-arms a step id to fail
 * WITHOUT invoking its callback — mirroring a real memoized failed step
 * being replayed into user code. To make that failure carry a specific
 * `RetryRefusalReason` the way a real `rethrowForInngest` call would have
 * produced it, `scriptedPermanentFailure` below builds the exact
 * `NonRetriableError`-wrapping-`WorkflowStepFailedError` shape
 * `rethrowForInngest` itself throws (see `inngest-errors.test.ts`'s
 * "recovers ... from a real Inngest StepError" test for the same pattern).
 */
function scriptedPermanentFailure(
  stepName: string,
  reason: RetryRefusalReason,
  cause: unknown,
): unknown {
  const original = new WorkflowStepFailedError(stepName, reason, cause);
  return new NonRetriableError(permanentStepFailureMessage(stepName, reason), {
    cause: original,
  });
}

function requestData() {
  return paymentExecuteRequestedSchema.parse({
    amount: 1000,
    currency: "USD",
    paymentMethodToken: "tok_visa",
    merchantId: "merchant-1",
  });
}

function baseCtx(runId: string, attempt = 0) {
  return { runId, attempt, data: requestData() };
}

describe("payment.execute compensation (driven via FakeWorkflowStep)", () => {
  it("capture fails terminally (402): cancels the authorization, refund/post-ledger never touched", async () => {
    const step = new FakeWorkflowStep();
    const payCore = new FakePayCoreClient();
    const ledger = new InMemoryLedgerRepository();
    const runId = "run-402";

    const authorized = authorizedPaymentResponse();
    payCore.scriptCreatePayment({ kind: "resolve", response: authorized });
    step.scriptFailure(
      "capture",
      scriptedPermanentFailure(
        "capture",
        "terminal_error",
        new PayCoreDeclinedError("declined", {
          operation: "capture_payment",
          status: 402,
          payCoreCode: "provider_declined",
        }),
      ),
    );
    payCore.scriptCancelPayment({
      kind: "resolve",
      response: { id: authorized.id, status: "canceled" },
    });

    let thrown: unknown;
    try {
      await runPaymentExecute(step, baseCtx(runId), { payCore, ledger });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NonRetriableError);
    const message = (thrown as Error).message;
    expect(message).toContain("capture");
    expect(message).toContain("terminal_error");
    expect(message).toContain("cancel-authorization");
    expect(message).not.toContain(NEEDS_REVIEW_MARKER);

    expect(payCore.calls.map((c) => c.method)).toEqual([
      "create_payment",
      "cancel_payment",
    ]);
    const cancelCall = payCore.calls[1]!;
    expect(cancelCall.request).toEqual({ paymentId: authorized.id });
    expect(cancelCall.idempotencyKey).toBeDefined();

    expect(step.ran).toEqual(["authorize", "capture", "compensate-authorize"]);
    expect(await ledger.findByPaymentId(authorized.id)).toEqual([]);
  });

  it("capture fails with attempts_exhausted: no compensating pay-core call at all, needs_review", async () => {
    const step = new FakeWorkflowStep();
    const payCore = new FakePayCoreClient();
    const ledger = new InMemoryLedgerRepository();
    const runId = "run-exhausted";

    const authorized = authorizedPaymentResponse();
    payCore.scriptCreatePayment({ kind: "resolve", response: authorized });
    step.scriptFailure(
      "capture",
      scriptedPermanentFailure(
        "capture",
        "attempts_exhausted",
        new PayCoreDeclinedError("unreachable", {
          operation: "capture_payment",
          status: undefined,
          payCoreCode: undefined,
        }),
      ),
    );

    let thrown: unknown;
    try {
      await runPaymentExecute(step, baseCtx(runId), { payCore, ledger });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NonRetriableError);
    const message = (thrown as Error).message;
    expect(message).toContain(NEEDS_REVIEW_MARKER);
    expect(message).toContain("attempts_exhausted");

    // Only authorize's real create_payment call happened — capture was
    // scripted to fail without invoking its callback, so capture_payment
    // was never actually called, and no compensating call was made either.
    expect(payCore.calls.map((c) => c.method)).toEqual(["create_payment"]);
    expect(await ledger.findByPaymentId(authorized.id)).toEqual([]);
  });

  it("post-ledger fails (PostingConflictError): no cancel, no refund, needs_review, ledger stays empty", async () => {
    const step = new FakeWorkflowStep();
    const payCore = new FakePayCoreClient();
    const ledger = new InMemoryLedgerRepository();
    const runId = "run-ledger-fail";

    const authorized = authorizedPaymentResponse();
    const captured = capturedPaymentResponse(authorized.id);
    payCore.scriptCreatePayment({ kind: "resolve", response: authorized });
    payCore.scriptCapturePayment({ kind: "resolve", response: captured });
    step.scriptFailure(
      "post-ledger",
      scriptedPermanentFailure(
        "post-ledger",
        "unclassified_error",
        new PostingConflictError("some-op-id", "attempted", "stored"),
      ),
    );

    let thrown: unknown;
    try {
      await runPaymentExecute(step, baseCtx(runId), { payCore, ledger });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NonRetriableError);
    const message = (thrown as Error).message;
    expect(message).toContain(NEEDS_REVIEW_MARKER);
    expect(message).toContain("unclassified_error");

    expect(payCore.calls.map((c) => c.method)).toEqual([
      "create_payment",
      "capture_payment",
    ]);
    expect(await ledger.findByPaymentId(authorized.id)).toEqual([]);
  });

  it("authorize fails terminally: original error rethrown verbatim, no compensated/needs_review framing", async () => {
    const step = new FakeWorkflowStep();
    const payCore = new FakePayCoreClient();
    const ledger = new InMemoryLedgerRepository();
    const runId = "run-authorize-fail";

    const scripted = scriptedPermanentFailure(
      "authorize",
      "terminal_error",
      new PayCoreBadRequestError("bad request", {
        operation: "create_payment",
        status: 400,
        payCoreCode: "validation_failed",
      }),
    );
    step.scriptFailure("authorize", scripted);

    let thrown: unknown;
    try {
      await runPaymentExecute(step, baseCtx(runId), { payCore, ledger });
    } catch (error) {
      thrown = error;
    }

    // "no_effects" route: the caught error is rethrown UNCHANGED, not
    // wrapped in compensatedFailureMessage/needsReviewMessage.
    expect(thrown).toBeDefined();
    const message = (thrown as Error).message;
    expect(message).not.toContain("compensated:");
    expect(message).not.toContain(NEEDS_REVIEW_MARKER);
    expect(payCore.calls).toEqual([]);
  });

  it("201-with-status:failed decline: rethrown verbatim, capture never runs, no compensation framing", async () => {
    const step = new FakeWorkflowStep();
    const payCore = new FakePayCoreClient();
    const ledger = new InMemoryLedgerRepository();
    const runId = "run-declined-authorize";

    const declined = declinedAtAuthorizeResponse();
    payCore.scriptCreatePayment({ kind: "resolve", response: declined });

    let thrown: unknown;
    try {
      await runPaymentExecute(step, baseCtx(runId), { payCore, ledger });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NonRetriableError);
    const message = (thrown as Error).message;
    expect(message).toContain("failed to authorize");
    expect(message).not.toContain("compensated:");
    expect(message).not.toContain(NEEDS_REVIEW_MARKER);

    expect(payCore.calls.map((c) => c.method)).toEqual(["create_payment"]);
    expect(step.ran).toEqual(["authorize"]);
  });

  it("compensation itself fails (422 on cancel): needs_review naming both the original step and the failed compensation", async () => {
    const step = new FakeWorkflowStep();
    const payCore = new FakePayCoreClient();
    const ledger = new InMemoryLedgerRepository();
    const runId = "run-compensation-fails";

    const authorized = authorizedPaymentResponse();
    payCore.scriptCreatePayment({ kind: "resolve", response: authorized });
    step.scriptFailure(
      "capture",
      scriptedPermanentFailure(
        "capture",
        "terminal_error",
        new PayCoreDeclinedError("declined", {
          operation: "capture_payment",
          status: 402,
          payCoreCode: "provider_declined",
        }),
      ),
    );
    // The compensating cancel is NOT pre-scripted on `step` — its callback
    // really runs, and the underlying pay-core call rejects.
    payCore.scriptCancelPayment({
      kind: "reject",
      error: new PayCoreIllegalStateError("illegal state", {
        operation: "cancel_payment",
        status: 422,
        payCoreCode: "illegal_state_transition",
      }),
    });

    let thrown: unknown;
    try {
      await runPaymentExecute(step, baseCtx(runId), { payCore, ledger });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NonRetriableError);
    const message = (thrown as Error).message;
    expect(message).toContain(NEEDS_REVIEW_MARKER);
    expect(message).toContain("capture");
    expect(message).toContain("compensate-authorize");
    // Distinguishable from a successful compensation's message shape.
    expect(message).not.toContain("compensated:");

    expect(payCore.calls.map((c) => c.method)).toEqual([
      "create_payment",
      "cancel_payment",
    ]);
  });

  it("happy path via FakeWorkflowStep matches the shape produced through InngestTestEngine", async () => {
    const step = new FakeWorkflowStep();
    const payCore = new FakePayCoreClient();
    const ledger = new InMemoryLedgerRepository();
    const runId = "run-happy";

    const authorized = authorizedPaymentResponse();
    const captured = capturedPaymentResponse(authorized.id);
    payCore.scriptCreatePayment({ kind: "resolve", response: authorized });
    payCore.scriptCapturePayment({ kind: "resolve", response: captured });

    const result = await runPaymentExecute(step, baseCtx(runId), {
      payCore,
      ledger,
    });

    expect(typeof result.ledgerOperationId).toBe("string");
    expect(result).toEqual({
      paymentId: captured.id,
      status: captured.status,
      currency: captured.currency,
      capturedAmount: captured.capturedAmount,
      ledgerOperationId: result.ledgerOperationId,
      ledgerOutcome: "posted",
    });
    expect(step.ran).toEqual(["authorize", "capture", "post-ledger"]);
    expect(payCore.calls.map((c) => c.method)).toEqual([
      "create_payment",
      "capture_payment",
    ]);
  });
});
