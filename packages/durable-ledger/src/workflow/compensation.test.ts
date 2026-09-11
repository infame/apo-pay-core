import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COMPENSATION_STEP_NAMES,
  compensatedFailureMessage,
  needsReviewMessage,
  planUnwind,
  runUnwind,
  type CompensationAction,
  type CompletedEffect,
} from "./compensation.js";
import { FakeWorkflowStep } from "./fake-workflow-step.js";
import { FakePayCoreClient } from "./fake-pay-core-client.js";
import { InMemoryLedgerRepository } from "../adapters/memory/in-memory-ledger-repository.js";
import { PostingGroup } from "../domain/entry.js";
import { Money } from "../domain/money.js";
import { LedgerAccount } from "../domain/account.js";
import { stepIdempotencyKey } from "./idempotency-key.js";
import { stepOperationId } from "./operation-id.js";
import type { RetryRefusalReason } from "./retry-policy.js";
import {
  PayCoreIllegalStateError,
  PayCoreUnavailableError,
} from "../ports/pay-core-errors.js";

const authorizedEffect = (paymentId: string): CompletedEffect => ({
  kind: "authorized",
  paymentId,
});
const capturedEffect = (paymentId: string): CompletedEffect => ({
  kind: "captured",
  paymentId,
  amount: 1000,
  currency: "USD",
});
const ledgerPostedEffect = (
  paymentId: string,
  operationId: string,
): CompletedEffect => ({
  kind: "ledger-posted",
  paymentId,
  operationId,
});

describe("planUnwind", () => {
  const reasons: readonly (RetryRefusalReason | undefined)[] = [
    "terminal_error",
    "attempts_exhausted",
    "unclassified_error",
    undefined,
  ];

  it.each(reasons)(
    "routes to no_effects when there are no effects at all, regardless of reason (%s)",
    (reason) => {
      expect(planUnwind({ reason, effects: [] })).toEqual({
        route: "no_effects",
      });
    },
  );

  it("terminal_error + [authorized] -> compensate: [cancel-authorization]", () => {
    const paymentId = randomUUID();
    const route = planUnwind({
      reason: "terminal_error",
      effects: [authorizedEffect(paymentId)],
    });
    expect(route).toEqual({
      route: "compensate",
      actions: [
        {
          kind: "cancel-authorization",
          stepName: "compensate-authorize",
          paymentId,
        },
      ],
    });
  });

  it("terminal_error + [authorized, captured] -> compensate: exactly [refund-capture], cancel-authorization absent (subsumption)", () => {
    const paymentId = randomUUID();
    const route = planUnwind({
      reason: "terminal_error",
      effects: [authorizedEffect(paymentId), capturedEffect(paymentId)],
    });
    expect(route.route).toBe("compensate");
    if (route.route !== "compensate") throw new Error("unreachable");
    expect(route.actions).toHaveLength(1);
    expect(route.actions[0]?.kind).toBe("refund-capture");
    expect(route.actions.some((a) => a.kind === "cancel-authorization")).toBe(
      false,
    );
  });

  it("terminal_error + [authorized, captured, ledger-posted] -> compensate: exactly [refund-capture, reverse-posting], in that order", () => {
    const paymentId = randomUUID();
    const operationId = randomUUID();
    const route = planUnwind({
      reason: "terminal_error",
      effects: [
        authorizedEffect(paymentId),
        capturedEffect(paymentId),
        ledgerPostedEffect(paymentId, operationId),
      ],
    });
    expect(route.route).toBe("compensate");
    if (route.route !== "compensate") throw new Error("unreachable");
    expect(route.actions.map((a) => a.kind)).toEqual([
      "refund-capture",
      "reverse-posting",
    ]);
  });

  it("attempts_exhausted with non-empty effects -> needs_review, because attempts_exhausted", () => {
    const route = planUnwind({
      reason: "attempts_exhausted",
      effects: [authorizedEffect(randomUUID())],
    });
    expect(route).toEqual({
      route: "needs_review",
      because: "attempts_exhausted",
    });
  });

  it("unclassified_error with non-empty effects -> needs_review, because unclassified_error", () => {
    const route = planUnwind({
      reason: "unclassified_error",
      effects: [authorizedEffect(randomUUID())],
    });
    expect(route).toEqual({
      route: "needs_review",
      because: "unclassified_error",
    });
  });

  it("undefined reason with non-empty effects -> needs_review, because unknown_failure", () => {
    const route = planUnwind({
      reason: undefined,
      effects: [authorizedEffect(randomUUID())],
    });
    expect(route).toEqual({
      route: "needs_review",
      because: "unknown_failure",
    });
  });
});

describe("runUnwind", () => {
  function setup() {
    const payCore = new FakePayCoreClient();
    const ledger = new InMemoryLedgerRepository();
    return { payCore, ledger };
  }

  it("a cancel-authorization action calls payCore.cancelPayment with a distinct compensate-authorize idempotency key", async () => {
    const { payCore, ledger } = setup();
    const paymentId = randomUUID();
    payCore.scriptCancelPayment({
      kind: "resolve",
      response: { id: paymentId, status: "canceled" },
    });
    const step = new FakeWorkflowStep();
    const runId = "run-1";
    const actions: readonly CompensationAction[] = [
      {
        kind: "cancel-authorization",
        stepName: "compensate-authorize",
        paymentId,
      },
    ];

    await runUnwind(step, {
      actions,
      runId,
      attempt: 0,
      deps: { payCore, ledger },
    });

    const call = payCore.calls[0];
    expect(call?.method).toBe("cancel_payment");
    expect(call?.idempotencyKey).toBe(
      stepIdempotencyKey(runId, "compensate-authorize"),
    );
    expect(call?.idempotencyKey).not.toBe(
      stepIdempotencyKey(runId, "authorize"),
    );
  });

  it("a refund-capture action calls payCore.refundPayment with its own distinct idempotency key", async () => {
    const { payCore, ledger } = setup();
    const paymentId = randomUUID();
    payCore.scriptRefundPayment({
      kind: "resolve",
      response: {
        id: paymentId,
        status: "refunded",
        currency: "USD",
        capturedAmount: 1000,
        refundedAmount: 1000,
      },
    });
    const step = new FakeWorkflowStep();
    const runId = "run-2";
    const actions: readonly CompensationAction[] = [
      {
        kind: "refund-capture",
        stepName: "compensate-capture",
        paymentId,
        amount: 1000,
      },
    ];

    await runUnwind(step, {
      actions,
      runId,
      attempt: 0,
      deps: { payCore, ledger },
    });

    const call = payCore.calls[0];
    expect(call?.method).toBe("refund_payment");
    expect(call?.idempotencyKey).toBe(
      stepIdempotencyKey(runId, "compensate-capture"),
    );
    expect(call?.idempotencyKey).not.toBe(stepIdempotencyKey(runId, "capture"));
  });

  it("runs actions strictly in the given array order", async () => {
    const { payCore, ledger } = setup();
    const paymentId = randomUUID();
    const operationId = stepOperationId("run-3", "post-ledger");
    const group = PostingGroup.forCapture({
      operationId,
      paymentId,
      merchantId: "merchant-1",
      amount: Money.of(1000, "USD"),
    });
    await ledger.post(group);
    payCore.scriptRefundPayment({
      kind: "resolve",
      response: {
        id: paymentId,
        status: "refunded",
        currency: "USD",
        capturedAmount: 1000,
        refundedAmount: 1000,
      },
    });
    const step = new FakeWorkflowStep();
    const actions: readonly CompensationAction[] = [
      {
        kind: "refund-capture",
        stepName: COMPENSATION_STEP_NAMES.captured,
        paymentId,
        amount: 1000,
      },
      {
        kind: "reverse-posting",
        stepName: COMPENSATION_STEP_NAMES["ledger-posted"],
        paymentId,
        originalOperationId: operationId,
      },
    ];

    await runUnwind(step, {
      actions,
      runId: "run-3",
      attempt: 0,
      deps: { payCore, ledger },
    });

    expect(step.ran).toEqual([
      COMPENSATION_STEP_NAMES.captured,
      COMPENSATION_STEP_NAMES["ledger-posted"],
    ]);
  });

  it("a reverse-posting action posts under a distinct operationId, leaves the original entries in place, and zeroes every affected account's balance", async () => {
    const { payCore, ledger } = setup();
    const paymentId = randomUUID();
    const runId = "run-4";
    const originalOperationId = stepOperationId(runId, "post-ledger");
    const group = PostingGroup.forCapture({
      operationId: originalOperationId,
      paymentId,
      merchantId: "merchant-1",
      amount: Money.of(1000, "USD"),
    });
    await ledger.post(group);
    const step = new FakeWorkflowStep();
    const actions: readonly CompensationAction[] = [
      {
        kind: "reverse-posting",
        stepName: COMPENSATION_STEP_NAMES["ledger-posted"],
        paymentId,
        originalOperationId,
      },
    ];

    const records = await runUnwind(step, {
      actions,
      runId,
      attempt: 0,
      deps: { payCore, ledger },
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("posted");

    const reversalOperationId = stepOperationId(
      runId,
      "compensate-post-ledger",
    );
    expect(reversalOperationId).not.toBe(originalOperationId);

    const original = await ledger.findByOperationId(originalOperationId);
    expect(original).toHaveLength(2);

    const clearingBalance = await ledger.getBalance(
      LedgerAccount.acquirerClearing(),
      "USD",
    );
    const merchantBalance = await ledger.getBalance(
      LedgerAccount.merchant("merchant-1"),
      "USD",
    );
    expect(clearingBalance.amount).toBe(0);
    expect(merchantBalance.amount).toBe(0);
  });

  it("running the exact same runUnwind call twice with the same runId/actions is idempotent: matching records, no duplicate effects", async () => {
    const { payCore, ledger } = setup();
    const paymentId = randomUUID();
    const runId = "run-5";
    const originalOperationId = stepOperationId(runId, "post-ledger");
    const group = PostingGroup.forCapture({
      operationId: originalOperationId,
      paymentId,
      merchantId: "merchant-1",
      amount: Money.of(1000, "USD"),
    });
    await ledger.post(group);
    payCore.scriptRefundPayment({
      kind: "resolve",
      response: {
        id: paymentId,
        status: "refunded",
        currency: "USD",
        capturedAmount: 1000,
        refundedAmount: 1000,
      },
    });
    payCore.scriptRefundPayment({
      kind: "resolve",
      response: {
        id: paymentId,
        status: "refunded",
        currency: "USD",
        capturedAmount: 1000,
        refundedAmount: 1000,
      },
    });
    const actions: readonly CompensationAction[] = [
      {
        kind: "refund-capture",
        stepName: COMPENSATION_STEP_NAMES.captured,
        paymentId,
        amount: 1000,
      },
      {
        kind: "reverse-posting",
        stepName: COMPENSATION_STEP_NAMES["ledger-posted"],
        paymentId,
        originalOperationId,
      },
    ];

    const first = await runUnwind(new FakeWorkflowStep(), {
      actions,
      runId,
      attempt: 0,
      deps: { payCore, ledger },
    });
    const second = await runUnwind(new FakeWorkflowStep(), {
      actions,
      runId,
      attempt: 0,
      deps: { payCore, ledger },
    });

    // Same shape both times — refund-capture's outcome is identical (a
    // second refund replays the stored idempotent result), while the
    // ledger reversal legitimately reports "posted" the first time and
    // "already_posted" the second, since it's a genuinely different check
    // against durable state, not a doubled effect.
    expect(
      second.map((r) => ({ stepName: r.stepName, action: r.action })),
    ).toEqual(first.map((r) => ({ stepName: r.stepName, action: r.action })));
    expect(first[0]?.outcome).toBe("refunded");
    expect(second[0]?.outcome).toBe("refunded");
    expect(first[1]?.outcome).toBe("posted");
    expect(second[1]?.outcome).toBe("already_posted");

    const reversalOperationId = stepOperationId(
      runId,
      "compensate-post-ledger",
    );
    const reversalEntries = await ledger.findByOperationId(reversalOperationId);
    expect(reversalEntries).toHaveLength(2); // not doubled

    const [refundCall1, refundCall2] = payCore.calls;
    expect(refundCall1?.idempotencyKey).toBe(refundCall2?.idempotencyKey);
  });

  it("a scripted PayCoreUnavailableError (503) inside a compensating action surfaces as a retryable failure", async () => {
    const { payCore, ledger } = setup();
    const paymentId = randomUUID();
    payCore.scriptCancelPayment({
      kind: "reject",
      error: new PayCoreUnavailableError("pay-core unavailable", {
        operation: "cancel_payment",
        status: 503,
        payCoreCode: "unavailable",
      }),
    });
    const step = new FakeWorkflowStep();
    const actions: readonly CompensationAction[] = [
      {
        kind: "cancel-authorization",
        stepName: "compensate-authorize",
        paymentId,
      },
    ];

    let thrown: unknown;
    try {
      await runUnwind(step, {
        actions,
        runId: "run-6",
        attempt: 0,
        deps: { payCore, ledger },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("RetryAfterError");
  });

  it("a scripted PayCoreIllegalStateError (422) surfaces as a NonRetriableError naming the specific compensate-… step", async () => {
    const { payCore, ledger } = setup();
    const paymentId = randomUUID();
    payCore.scriptCancelPayment({
      kind: "reject",
      error: new PayCoreIllegalStateError("illegal state", {
        operation: "cancel_payment",
        status: 422,
        payCoreCode: "illegal_state",
      }),
    });
    const step = new FakeWorkflowStep();
    const actions: readonly CompensationAction[] = [
      {
        kind: "cancel-authorization",
        stepName: "compensate-authorize",
        paymentId,
      },
    ];

    let thrown: unknown;
    try {
      await runUnwind(step, {
        actions,
        runId: "run-7",
        attempt: 0,
        deps: { payCore, ledger },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("NonRetriableError");
    expect((thrown as Error).message).toContain("compensate-authorize");
  });
});

describe("compensatedFailureMessage / needsReviewMessage", () => {
  it("compensatedFailureMessage names the failed step, reason, and each compensating action", () => {
    const message = compensatedFailureMessage({
      failedStep: "capture",
      reason: "terminal_error",
      actions: [
        {
          kind: "cancel-authorization",
          stepName: "compensate-authorize",
          paymentId: "p1",
        },
      ],
    });
    expect(message).toContain("capture");
    expect(message).toContain("terminal_error");
    expect(message).toContain("cancel-authorization");
  });

  it("needsReviewMessage (no compensation attempted) names the failed step and cause, and carries the marker", () => {
    const message = needsReviewMessage({
      failedStep: "post-ledger",
      because: "unclassified_error",
    });
    expect(message).toContain("needs_review:");
    expect(message).toContain("post-ledger");
    expect(message).toContain("unclassified_error");
  });

  it("needsReviewMessage (compensation_failed) names both the original failed step and the failed compensation step", () => {
    const message = needsReviewMessage({
      failedStep: "capture",
      because: "compensation_failed",
      compensationStep: "compensate-authorize",
    });
    expect(message).toContain("needs_review:");
    expect(message).toContain("capture");
    expect(message).toContain("compensate-authorize");
  });
});
