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
 */
export class WorkflowStepFailedError extends Error {
  override readonly name = "WorkflowStepFailedError";

  constructor(
    readonly stepName: string,
    readonly reason: RetryRefusalReason,
    override readonly cause: unknown,
  ) {
    super(`Step "${stepName}" failed: ${reason}`);
  }
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
    `Step "${stepName}" failed permanently: ${decision.reason}`,
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
