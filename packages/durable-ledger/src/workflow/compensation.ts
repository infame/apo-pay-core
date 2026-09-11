import type { RetryRefusalReason, DecideRetryOptions } from "./retry-policy.js";
import type { PayCoreClient } from "../ports/pay-core-client.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";
import type { WorkflowStep } from "./workflow-step.js";
import { PostingGroup } from "../domain/entry.js";
import { stepIdempotencyKey } from "./idempotency-key.js";
import { stepOperationId } from "./operation-id.js";
import { rethrowForInngest } from "./inngest-errors.js";

/**
 * One durable effect `payment.execute`'s forward path has already caused,
 * in the order it can only ever occur (authorize -> capture -> ledger-post).
 * `planUnwind` reads the LATEST of these to decide what needs undoing —
 * see its own doc comment for the "refund subsumes cancel" reasoning.
 */
export type CompletedEffect =
  | { readonly kind: "authorized"; readonly paymentId: string }
  | {
      readonly kind: "captured";
      readonly paymentId: string;
      readonly amount: number;
      readonly currency: string;
    }
  | {
      readonly kind: "ledger-posted";
      readonly paymentId: string;
      readonly operationId: string;
    };

export const COMPENSATION_STEP_NAMES = {
  authorized: "compensate-authorize",
  captured: "compensate-capture",
  "ledger-posted": "compensate-post-ledger",
} as const satisfies Record<CompletedEffect["kind"], string>;

/** One compensating action, ready to run as its own durable step. */
export type CompensationAction =
  | {
      readonly kind: "cancel-authorization";
      readonly stepName: "compensate-authorize";
      readonly paymentId: string;
    }
  | {
      readonly kind: "refund-capture";
      readonly stepName: "compensate-capture";
      readonly paymentId: string;
      readonly amount: number;
    }
  | {
      readonly kind: "reverse-posting";
      readonly stepName: "compensate-post-ledger";
      readonly paymentId: string;
      readonly originalOperationId: string;
    };

export type NeedsReviewCause =
  | "attempts_exhausted"
  | "unclassified_error"
  | "unknown_failure"
  | "compensation_failed";

export type UnwindRoute =
  | { readonly route: "no_effects" }
  | {
      readonly route: "compensate";
      readonly actions: readonly CompensationAction[];
    }
  | { readonly route: "needs_review"; readonly because: NeedsReviewCause };

/**
 * PURE. The compensation decision table for `payment.execute`'s three
 * steps — given what already happened (`effects`, in the order the forward
 * path can only ever produce them) and why the run stopped (`reason`,
 * `undefined` if the failure couldn't even be classified), decides what
 * happens next:
 *
 * - No effects at all -> `"no_effects"`. Nothing succeeded, so there is
 *   nothing to unwind; the caller rethrows the original error verbatim.
 * - `reason === "terminal_error"` with non-empty effects -> `"compensate"`,
 *   with `actions` derived from the LATEST/highest completed effect only:
 *   **refund subsumes cancel**. Once a payment has been captured, only
 *   `refund-capture` is needed — issuing `cancelPayment` afterwards on an
 *   already-captured payment is itself an illegal state transition pay-core
 *   would reject with a 422 (`PayCoreIllegalStateError`), turning a
 *   successful compensation into a spurious `needs_review`. If
 *   `ledger-posted` is also present, the ledger posting ALSO gets
 *   compensated via `reverse-posting`, ordered `refund-capture` THEN
 *   `reverse-posting` — refund before reversal, deliberately, per the
 *   accounting-integrity principle that a ledger movement must never be
 *   recorded for money that wasn't actually returned. If the refund call
 *   fails, the ledger is merely stale (safe); reversing first and having
 *   the refund then fail would leave the ledger actively lying about money
 *   that was never returned.
 * - `reason` is `"attempts_exhausted"` or `"unclassified_error"` or
 *   `undefined`, with non-empty effects -> `"needs_review"`, `because` set
 *   accordingly (`"unknown_failure"` when `reason` is `undefined` but
 *   effects exist). None of these ever compensate automatically:
 *   `attempts_exhausted` means the retry budget genuinely ran out on a
 *   possibly-still-retryable condition (compensating could race a delayed
 *   success), and `unclassified_error` means the failure wasn't even
 *   recognized as a `PayCoreClientError` (a ledger bug, a programming
 *   error) — acting on it automatically risks compounding whatever already
 *   went wrong. A human reviewing the run is safer than guessing.
 */
export function planUnwind(params: {
  readonly reason: RetryRefusalReason | undefined;
  readonly effects: readonly CompletedEffect[];
}): UnwindRoute {
  const { reason, effects } = params;

  if (effects.length === 0) {
    return { route: "no_effects" };
  }

  if (reason === "attempts_exhausted") {
    return { route: "needs_review", because: "attempts_exhausted" };
  }
  if (reason === "unclassified_error") {
    return { route: "needs_review", because: "unclassified_error" };
  }
  if (reason === undefined) {
    return { route: "needs_review", because: "unknown_failure" };
  }

  // reason === "terminal_error": build actions from the latest effect only.
  const captured = effects.find(
    (effect): effect is Extract<CompletedEffect, { kind: "captured" }> =>
      effect.kind === "captured",
  );
  const ledgerPosted = effects.find(
    (effect): effect is Extract<CompletedEffect, { kind: "ledger-posted" }> =>
      effect.kind === "ledger-posted",
  );
  const authorized = effects.find(
    (effect): effect is Extract<CompletedEffect, { kind: "authorized" }> =>
      effect.kind === "authorized",
  );

  const actions: CompensationAction[] = [];
  if (captured !== undefined) {
    actions.push({
      kind: "refund-capture",
      stepName: COMPENSATION_STEP_NAMES.captured,
      paymentId: captured.paymentId,
      amount: captured.amount,
    });
    if (ledgerPosted !== undefined) {
      actions.push({
        kind: "reverse-posting",
        stepName: COMPENSATION_STEP_NAMES["ledger-posted"],
        paymentId: ledgerPosted.paymentId,
        originalOperationId: ledgerPosted.operationId,
      });
    }
  } else if (authorized !== undefined) {
    actions.push({
      kind: "cancel-authorization",
      stepName: COMPENSATION_STEP_NAMES.authorized,
      paymentId: authorized.paymentId,
    });
  }

  return { route: "compensate", actions };
}

export interface CompensationDeps {
  readonly payCore: PayCoreClient;
  readonly ledger: LedgerRepository;
  readonly retry?: DecideRetryOptions;
}

export interface CompensationRecord {
  readonly stepName: string;
  readonly action: CompensationAction["kind"];
  readonly outcome: string;
}

/**
 * Runs each action in `params.actions` as its own durable, idempotent,
 * Inngest-retryable `step.run(...)` call, strictly in the given order. Does
 * NOT catch — a failing compensating step propagates to the caller exactly
 * like a forward-path step failure does, via `rethrowForInngest` inside
 * each action's own try/catch (same rule as every forward-path step, per
 * ADR-0008: the classification catch must live INSIDE `step.run`, never
 * around it).
 */
export async function runUnwind(
  step: WorkflowStep,
  params: {
    readonly actions: readonly CompensationAction[];
    readonly runId: string;
    readonly attempt: number;
    readonly deps: CompensationDeps;
  },
): Promise<readonly CompensationRecord[]> {
  const { actions, runId, attempt, deps } = params;
  const records: CompensationRecord[] = [];

  for (const action of actions) {
    records.push(await runOneAction(step, action, runId, attempt, deps));
  }

  return records;
}

async function runOneAction(
  step: WorkflowStep,
  action: CompensationAction,
  runId: string,
  attempt: number,
  deps: CompensationDeps,
): Promise<CompensationRecord> {
  switch (action.kind) {
    case "cancel-authorization": {
      const response = await step.run(action.stepName, async () => {
        try {
          return await deps.payCore.cancelPayment(
            { paymentId: action.paymentId },
            {
              idempotencyKey: stepIdempotencyKey(runId, action.stepName),
            },
          );
        } catch (error) {
          rethrowForInngest(action.stepName, error, attempt + 1, deps.retry);
        }
      });
      return {
        stepName: action.stepName,
        action: action.kind,
        outcome: response.status,
      };
    }
    case "refund-capture": {
      const response = await step.run(action.stepName, async () => {
        try {
          return await deps.payCore.refundPayment(
            { paymentId: action.paymentId, amount: action.amount },
            {
              idempotencyKey: stepIdempotencyKey(runId, action.stepName),
            },
          );
        } catch (error) {
          rethrowForInngest(action.stepName, error, attempt + 1, deps.retry);
        }
      });
      return {
        stepName: action.stepName,
        action: action.kind,
        outcome: response.status,
      };
    }
    case "reverse-posting": {
      const response = await step.run(action.stepName, async () => {
        const original = await deps.ledger.findByOperationId(
          action.originalOperationId,
        );
        const reversalOperationId = stepOperationId(runId, action.stepName);
        const group = PostingGroup.reversalOf({
          original,
          operationId: reversalOperationId,
        });
        const result = await deps.ledger.post(group);
        return { operationId: reversalOperationId, outcome: result.outcome };
      });
      return {
        stepName: action.stepName,
        action: action.kind,
        outcome: response.outcome,
      };
    }
  }
}

export const NEEDS_REVIEW_MARKER = "needs_review:";

/** e.g. `payment.execute failed at step "capture" (terminal_error); compensated: cancel-authorization`. */
export function compensatedFailureMessage(p: {
  readonly failedStep: string | undefined;
  readonly reason: RetryRefusalReason;
  readonly actions: readonly CompensationAction[];
}): string {
  const step = p.failedStep ?? "unknown";
  const actionKinds = p.actions.map((action) => action.kind).join(", ");
  return `payment.execute failed at step "${step}" (${p.reason}); compensated: ${actionKinds}`;
}

/**
 * e.g. `payment.execute needs_review: step "post-ledger" failed
 * (unclassified_error); no compensation attempted` or `payment.execute
 * needs_review: compensation "compensate-authorize" failed while unwinding
 * step "capture"`. Always starts with `NEEDS_REVIEW_MARKER` so a caller (or
 * a future dead-letter consumer) can recognize this route without parsing
 * the rest of the message.
 */
export function needsReviewMessage(p: {
  readonly failedStep: string | undefined;
  readonly because: NeedsReviewCause;
  readonly compensationStep?: string;
}): string {
  const step = p.failedStep ?? "unknown";
  if (p.because === "compensation_failed") {
    const compensationStep = p.compensationStep ?? "unknown";
    return `payment.execute ${NEEDS_REVIEW_MARKER} compensation "${compensationStep}" failed while unwinding step "${step}"`;
  }
  return `payment.execute ${NEEDS_REVIEW_MARKER} step "${step}" failed (${p.because}); no compensation attempted`;
}
