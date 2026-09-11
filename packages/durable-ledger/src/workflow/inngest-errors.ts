import { NonRetriableError, RetryAfterError } from "inngest";
import type {
  DecideRetryOptions,
  RetryPolicy,
  RetryRefusalReason,
} from "./retry-policy.js";
import { decideRetry } from "./retry-policy.js";

/**
 * Carried as `NonRetriableError`'s `cause` so step 7 can route
 * `terminal_error`/`unclassified_error` -> compensation and
 * `attempts_exhausted` -> `needs_review` (spec §8) without re-running
 * `decideRetry`'s classification a second time.
 *
 * `code` mirrors `reason` (this repo's `code`-discriminator convention,
 * `packages/pay-core/src/domain/errors.ts`) — it does NOT help production:
 * a real Inngest `StepError`'s `.cause` loses custom fields, `code`
 * included, when Inngest deserializes it (see
 * `docs/adr/0009-compensation-routing-and-the-workflow-step-seam.md`). It
 * exists so same-process tests (this file's own, and `compensation.test.ts`)
 * can assert `error.cause.code === "terminal_error"` instead of
 * substring-matching a message.
 */
export class WorkflowStepFailedError extends Error {
  override readonly name = "WorkflowStepFailedError";
  readonly code: RetryRefusalReason;

  constructor(
    readonly stepName: string,
    readonly reason: RetryRefusalReason,
    override readonly cause: unknown,
  ) {
    super(`Step "${stepName}" failed: ${reason}`);
    this.code = reason;
  }
}

/**
 * Single source of truth for the failure message a permanently-refused step
 * produces: `rethrowForInngest` throws it (as the `NonRetriableError`'s own
 * message), and `stepFailureOf` parses it back out of whatever survives
 * Inngest's error-serialization boundary. Keep them in lockstep — a test in
 * `inngest-errors.test.ts` round-trips this.
 */
export function permanentStepFailureMessage(
  stepName: string,
  reason: RetryRefusalReason,
): string {
  return `Step "${stepName}" failed permanently: ${reason}`;
}

/**
 * Translates a `decideRetry` decision into Inngest's own retry vocabulary
 * and throws it — see ADR-0007 ("Inngest owns the retry loop") and
 * ADR-0008 for why this must be called.
 *
 * **MUST be called from INSIDE a `step.run(...)` callback's catch block,
 * never from the surrounding handler.** Inngest does not rethrow the
 * original error object to the outer handler — a step failure surfaces
 * there as a serialized `StepError`, so `error instanceof
 * PayCoreClientError` (which `decideRetry` depends on via `isRetryable`)
 * only holds true inside the callback itself, before Inngest has had a
 * chance to serialize anything.
 */
export function rethrowForInngest(
  stepName: string,
  error: unknown,
  attempt: number,
  options?: DecideRetryOptions,
): never {
  const decision = decideRetry(error, attempt, options);

  if (decision.shouldRetry) {
    throw new RetryAfterError(
      `Step "${stepName}" failed, retrying`,
      decision.delayMs,
      {
        cause: error,
      },
    );
  }

  throw new NonRetriableError(
    permanentStepFailureMessage(stepName, decision.reason),
    { cause: new WorkflowStepFailedError(stepName, decision.reason, error) },
  );
}

/** The exact literal union `InngestFunction.Options["retries"]` accepts in the installed `inngest@4.20.0` — re-declared here (not imported) because the SDK doesn't export this literal union as a standalone type. */
export type InngestRetries =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20;

const MIN_INNGEST_RETRIES = 0;
const MAX_INNGEST_RETRIES = 20;

/**
 * Pins Inngest's retry ceiling to the policy's `maxAttempts`, per ADR-0007:
 * `policy.maxAttempts` total attempts = 1 initial attempt +
 * (`maxAttempts` - 1) Inngest retries.
 *
 * Throws (rather than silently clamping) if `policy.maxAttempts - 1` falls
 * outside Inngest's `0-20` valid range — a policy that can't be honored
 * exactly should fail loudly at wiring time, not silently run with a
 * smaller/larger retry budget than configured.
 */
export function inngestRetriesFor(policy: RetryPolicy): InngestRetries {
  const retries = policy.maxAttempts - 1;
  if (
    !Number.isInteger(retries) ||
    retries < MIN_INNGEST_RETRIES ||
    retries > MAX_INNGEST_RETRIES
  ) {
    throw new Error(
      `inngestRetriesFor: policy.maxAttempts - 1 must be an integer in [${String(MIN_INNGEST_RETRIES)}, ${String(MAX_INNGEST_RETRIES)}], got ${String(retries)} (maxAttempts=${String(policy.maxAttempts)})`,
    );
  }
  return retries as InngestRetries;
}

export interface StepFailure {
  readonly stepName: string | undefined;
  readonly reason: RetryRefusalReason | undefined;
}

const PERMANENT_FAILURE_REASON_PATTERN =
  /failed permanently: (terminal_error|attempts_exhausted|unclassified_error)/;

function isWorkflowStepFailedError(
  value: unknown,
): value is WorkflowStepFailedError {
  return value instanceof WorkflowStepFailedError;
}

function causeOf(value: unknown): unknown {
  return value instanceof Error ? value.cause : undefined;
}

function messageOf(value: unknown): string | undefined {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { readonly message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

function stepIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("stepId" in value)) {
    return undefined;
  }
  const stepId = (value as { readonly stepId?: unknown }).stepId;
  return typeof stepId === "string" ? stepId : undefined;
}

function reasonFromMessage(
  message: string | undefined,
): RetryRefusalReason | undefined {
  if (message === undefined) {
    return undefined;
  }
  const match = PERMANENT_FAILURE_REASON_PATTERN.exec(message);
  return match ? (match[1] as RetryRefusalReason) : undefined;
}

/**
 * Recovers `(stepName, reason)` from whatever the calling code actually
 * caught. Must work on THREE distinct shapes (see ADR-0009 for the full
 * writeup, including how shape 3 was verified against the real library):
 *
 *  1. A live `WorkflowStepFailedError` (same-process throws, e.g. a unit
 *     test constructing one directly, or unwrapping it from a live
 *     `NonRetriableError.cause`).
 *  2. The `NonRetriableError` that `rethrowForInngest` itself throws, whose
 *     `.cause` is a `WorkflowStepFailedError` — still same-process, still
 *     has its custom fields intact.
 *  3. A real Inngest `StepError`, as a production handler actually receives
 *     it once a memoized failed step is replayed into user code — where
 *     custom fields do NOT survive Inngest's own error
 *     serialize/deserialize boundary (confirmed: a `StepError`'s `.cause`
 *     loses even `WorkflowStepFailedError.code`, because the nested-cause
 *     branch of Inngest's own `jsonErrorSchema` has no `.passthrough()`,
 *     unlike its top level). Only `err.stepId` (unhashed, e.g. `"capture"`)
 *     and the message text survive, so this shape is recovered by
 *     duck-typing a `stepId` property and regex-parsing `reason` out of
 *     `permanentStepFailureMessage`'s format wherever it appears in the
 *     message chain — which, empirically, is the top-level `StepError`'s
 *     own `.message` (copied from the `NonRetriableError` that produced it),
 *     not `.cause.message`.
 *
 * Defensive by construction: every lookup is duck-typed/`instanceof`-guarded
 * and the whole function is wrapped in a `try`/`catch` — this must never
 * throw, only ever return a `StepFailure` (possibly with `undefined`
 * fields), including for `"boom"`, `undefined`, `null`, or a plain `Error`.
 */
export function stepFailureOf(error: unknown): StepFailure {
  try {
    if (isWorkflowStepFailedError(error)) {
      return { stepName: error.stepName, reason: error.reason };
    }
    const cause = causeOf(error);
    if (isWorkflowStepFailedError(cause)) {
      return { stepName: cause.stepName, reason: cause.reason };
    }

    const stepName = stepIdOf(error) ?? stepIdOf(cause);
    const reason =
      reasonFromMessage(messageOf(error)) ??
      reasonFromMessage(messageOf(cause)) ??
      reasonFromMessage(messageOf(causeOf(cause)));

    return { stepName, reason };
  } catch {
    return { stepName: undefined, reason: undefined };
  }
}
