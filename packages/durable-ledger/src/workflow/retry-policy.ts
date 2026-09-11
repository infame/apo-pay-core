import { PayCoreClientError } from "../ports/pay-core-errors.js";

/**
 * Pure retry-decision policy for calls made through `PayCoreClient`. Given an
 * error and how many attempts have already been made, `decideRetry` answers
 * "should there be another attempt, and if so after how long" — nothing more.
 *
 * **This module deliberately contains no loop, no `setTimeout`, no actual
 * retrying.** Inngest (step 6) owns the durable retry loop via its own
 * `step.run` attempt/backoff mechanism, which survives a process crash
 * between attempts the way an in-process loop never could. Nesting a second,
 * local attempt loop inside a durable step would be strictly worse than not
 * having one: it wouldn't survive a crash the way Inngest's own retry does
 * (defeating the entire point of running this inside Inngest), and it would
 * multiply real HTTP attempts against a dependency that is, by definition,
 * already degraded when this code runs — this policy's own `maxAttempts: 4`
 * nested inside Inngest's configured retries could turn one logical
 * operation into up to 16 real HTTP calls (4 × 4), the kind of retry
 * amplification that turns a struggling dependency into a fully down one.
 * That's the exact "second mechanism duplicating Inngest" shape this repo's
 * own spec already rejected for a transactional-outbox *dispatcher*
 * (ADR-0003: "a dispatcher here would be a second mechanism in the same
 * place... reliable, durable delivery is provided by Inngest") and for saga
 * libraries — this package hand-rolls its own compensation step registry
 * (step 7) rather than pulling one in, for the same reason. `decideRetry`
 * exists so step 6 can ask "what should happen next", not "make it happen".
 *
 * **Backoff formula** (`backoffDelayMs`):
 * ```
 * exp       = min(baseDelayMs * backoffMultiplier ** (attempt - 1), maxDelayMs)
 * jittered  = exp / 2 + rng() * (exp / 2)     // equal jitter, ∈ [exp/2, exp)
 * delayMs   = min(round(max(jittered, hint)), maxDelayMs)
 * ```
 * `attempt` is 1-based and names the attempt whose *next* delay is being
 * computed: `backoffDelayMs(1, ...)` is the wait before the first retry,
 * i.e. after attempt 1 has already failed.
 *
 * **Why equal jitter, not full jitter.** "Full jitter" (`rng() * exp`) can
 * return a delay near zero, which can re-hit a resource that JUST signaled
 * it's overloaded — the opposite of what backoff is for. Equal jitter
 * (`exp/2 + rng() * exp/2`) guarantees every delay is at least half the
 * unjittered exponential, so there's always a minimum spacing between
 * attempts, while the random half still de-synchronizes concurrent callers
 * that failed at the same moment (avoiding a thundering herd all retrying on
 * the exact same clock tick).
 *
 * **Why the server's `Retry-After` hint is a floor (`max(jittered, hint)`),
 * never a replacement.** pay-core telling us "wait 5s" can only ever
 * *extend* a wait our own backoff already computed, never shorten one that's
 * already escalated past it — honoring a *shorter* hint than our own
 * schedule would undercut backoff that grew for a reason (repeated
 * failures). This also means a hint of exactly `0` can never force a
 * hot-loop: it simply loses to `max()` and normal backoff applies. A `0`
 * hint is a real, reachable case, not a hypothetical — pay-core's
 * `Retry-After` header is computed as `Math.ceil(ms / 1000)`
 * (`packages/pay-core/src/adapters/http/error-mapper.ts`), so any
 * sub-second `retryAfterMs` (e.g. `100`) serializes to the header value
 * `"0"`.
 *
 * **Why an unclassified (non-`PayCoreClientError`) error does not retry.**
 * The spec is explicit that this package must not "ретраим всё подряд"
 * (retry everything indiscriminately) — durable-ledger spec §2. Every error
 * that can escape `HttpPayCoreClient` is already funneled through
 * `payCoreErrorFor` (`src/adapters/http/error-mapper.ts`) into some
 * `PayCoreClientError` subclass, so anything else reaching `decideRetry` is
 * a different *kind* of failure entirely — a `LedgerError` invariant
 * violation, a `PostingConflictError`, or a plain bug — none of which
 * "un-happen" on a retry. Retrying those would just repeat (or mask) the
 * bug rather than recover from a transient condition.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly backoffMultiplier: number;
  readonly maxDelayMs: number;
}

export type RetryPolicyOverrides = Partial<RetryPolicy>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  backoffMultiplier: 2,
  maxDelayMs: 30_000,
};

export type RetryRefusalReason =
  "terminal_error" | "attempts_exhausted" | "unclassified_error";

export type RetryDelaySource = "backoff" | "server_hint";

export type RetryDecision =
  | {
      readonly shouldRetry: true;
      readonly attempt: number;
      readonly delayMs: number;
      readonly source: RetryDelaySource;
    }
  | {
      readonly shouldRetry: false;
      readonly attempt: number;
      readonly reason: RetryRefusalReason;
    };

export interface DecideRetryOptions {
  readonly policy?: RetryPolicyOverrides;
  readonly rng?: () => number;
}

/** `error instanceof PayCoreClientError ? error.retryable : false` — reads the classification `HttpPayCoreClient`/`payCoreErrorFor` already computed, never recomputes it. */
export function isRetryable(error: unknown): boolean {
  return error instanceof PayCoreClientError ? error.retryable : false;
}

/**
 * Structural, not narrowed to a specific subclass: reads `retryAfterMs` off
 * any `PayCoreClientError` instance that happens to carry one, so a future
 * subclass gains the behavior without this file needing an edit. Gated on
 * `instanceof PayCoreClientError` so an arbitrary object that merely *looks*
 * like one (duck typing) is never trusted — only an actual `PayCoreClientError`
 * counts. Returns the value only if it's a finite number `>= 0`.
 */
export function retryAfterMsOf(error: unknown): number | undefined {
  if (!(error instanceof PayCoreClientError)) {
    return undefined;
  }
  const candidate = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0
    ? candidate
    : undefined;
}

/**
 * Merges `overrides` onto `DEFAULT_RETRY_POLICY` and validates the result.
 * Throws a plain `Error`, not a `LedgerError` subclass — same reasoning as
 * `stepIdempotencyKey` (`src/workflow/idempotency-key.ts`): this validates
 * an input to a workflow-layer helper, not a ledger domain invariant.
 */
export function resolveRetryPolicy(
  overrides?: RetryPolicyOverrides,
): RetryPolicy {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...overrides };

  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error(
      `resolveRetryPolicy: maxAttempts must be an integer >= 1, got ${String(policy.maxAttempts)}`,
    );
  }
  if (!(policy.baseDelayMs > 0)) {
    throw new Error(
      `resolveRetryPolicy: baseDelayMs must be > 0, got ${String(policy.baseDelayMs)}`,
    );
  }
  if (!(policy.backoffMultiplier >= 1)) {
    throw new Error(
      `resolveRetryPolicy: backoffMultiplier must be >= 1, got ${String(policy.backoffMultiplier)}`,
    );
  }
  if (!(policy.maxDelayMs >= policy.baseDelayMs)) {
    throw new Error(
      `resolveRetryPolicy: maxDelayMs must be >= baseDelayMs, got maxDelayMs=${String(policy.maxDelayMs)} baseDelayMs=${String(policy.baseDelayMs)}`,
    );
  }

  return policy;
}

/**
 * Computes the delay before the given (1-based) attempt's retry. See the
 * module header for the formula and the reasoning behind equal jitter and
 * the server-hint floor.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  rng?: () => number,
  serverHintMs?: number,
): { readonly delayMs: number; readonly source: RetryDelaySource } {
  const nextRng = rng ?? Math.random;
  const exp = Math.min(
    policy.baseDelayMs * policy.backoffMultiplier ** (attempt - 1),
    policy.maxDelayMs,
  );
  const r = nextRng();
  const rClamped = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0;
  const jittered = exp / 2 + rClamped * (exp / 2);
  const hint =
    serverHintMs === undefined
      ? 0
      : Math.min(Math.max(serverHintMs, 0), policy.maxDelayMs);
  const delayMs = Math.min(
    Math.round(Math.max(jittered, hint)),
    policy.maxDelayMs,
  );
  const source: RetryDelaySource = hint > jittered ? "server_hint" : "backoff";

  return { delayMs, source };
}

/**
 * Decides whether a `PayCoreClient` call should be retried after `attempt`
 * has failed with `error`, and if so, after how long. See the module header
 * for why this returns a decision only and never performs the retry itself.
 *
 * Precedence (load-bearing — step 6 routes `terminal_error` and
 * `attempts_exhausted` to different outcomes, so a terminal error on the
 * final attempt must still report `terminal_error`):
 * 1. Validate `attempt`.
 * 2. Resolve (and validate) the policy.
 * 3. Classify: not retryable at all -> refuse, before checking attempts left.
 * 4. Attempts exhausted -> refuse.
 * 5. Otherwise -> compute the backoff delay.
 */
export function decideRetry(
  error: unknown,
  attempt: number,
  options?: DecideRetryOptions,
): RetryDecision {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(
      `decideRetry: attempt must be a positive integer, got ${String(attempt)}`,
    );
  }

  const policy = resolveRetryPolicy(options?.policy);

  if (!isRetryable(error)) {
    return {
      shouldRetry: false,
      attempt,
      reason:
        error instanceof PayCoreClientError
          ? "terminal_error"
          : "unclassified_error",
    };
  }

  if (attempt >= policy.maxAttempts) {
    return { shouldRetry: false, attempt, reason: "attempts_exhausted" };
  }

  const { delayMs, source } = backoffDelayMs(
    attempt,
    policy,
    options?.rng,
    retryAfterMsOf(error),
  );

  return { shouldRetry: true, attempt, delayMs, source };
}
