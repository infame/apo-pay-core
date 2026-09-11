# 7. `decideRetry` is a pure decision function — Inngest owns the actual retry loop

Date: 2026-09-11

## Status

Accepted

## Context

`packages/durable-ledger`'s step 5 needed to decide whether a failed
`PayCoreClient` call is worth retrying and, if so, after how long. The
obvious shape for "a retry policy" is a helper that actually performs the
retry — `withRetry(fn: () => Promise<T>, policy: RetryPolicy): Promise<T>`,
sleeping and re-invoking `fn` internally. That shape was considered and
rejected.

The rejection turns on one fact: step 6 will call this policy from inside an
Inngest `step.run(...)`. Inngest's own step mechanism already retries a
throwing step on its own schedule, with its own attempt counter and its own
backoff — and that retry survives a process crash between attempts, which is
the entire premise of using Inngest at all (spec §1: "процесс переживает
падение и продолжается с несделанного шага" — the process survives a crash
and continues from the unfinished step).

Nesting a `withRetry`-style loop inside a `step.run` callback would not be a
second safety net; it would be strictly worse than having none:

- **Not durable.** A `setTimeout`-based wait and its accumulated attempt
  count live in process memory. If the process crashes mid-wait, that state
  is gone — Inngest restarts the *step* from attempt 1, so the nested loop's
  own progress was never real durability, just an illusion of one.
- **Retry amplification.** A local policy retrying up to 4 times, itself
  wrapped in an Inngest step configured to retry up to 4 times, turns one
  logical operation into up to 4 × 4 = 16 real HTTP calls against a
  dependency that is, by construction, already failing when this code runs.
  Retry amplification against a degraded dependency is a well-known driver
  of cascading/metastable failure — the two ceilings compound instead of
  composing, and neither one's count reflects what's actually happening on
  the wire.
- **The spec assigns the loop to Inngest, not to this package.** §4.2
  annotates the capture step "эквайер может дать 503 → Inngest ретраит шаг"
  (the acquirer may return 503 → Inngest retries the step) — durable-ledger
  spec's own words assign the retrying to Inngest. §13 step 5 scopes this
  file to `isRetryable(error)` and backoff, not to a driver loop.
- **This repo has already made this exact call once.** ADR-0003 descopes an
  outbox *dispatcher* from `pay-core` for the identical reason: "reliable,
  durable delivery is provided by Inngest in `durable-ledger`; a dispatcher
  here would be a second mechanism in the same place." A `withRetry` helper
  sitting next to Inngest's own step-retry is that same mistake, one layer
  up the stack.

## Decision

`src/workflow/retry-policy.ts` exports pure functions only —
`isRetryable`, `retryAfterMsOf`, `backoffDelayMs`, `resolveRetryPolicy`, and
the composed `decideRetry(error, attempt, options?)` — and performs no
sleeping, no looping, and no actual retrying anywhere in this package.

`decideRetry` returns a `RetryDecision`: `{ shouldRetry: true, delayMs,
source }` or `{ shouldRetry: false, reason }`, where `reason` is one of
`"terminal_error"`, `"attempts_exhausted"`, or `"unclassified_error"`. Step
6's Inngest workflow is expected to call `decideRetry` inside its
`step.run(...)` error handling and translate the result into Inngest's own
vocabulary — rethrowing something like `RetryAfterError(message, delayMs)`
on `shouldRetry: true` (so Inngest performs the actual durable wait+re-run),
and `NonRetriableError` otherwise, routing `terminal_error`/
`unclassified_error` toward compensation (step 7) and `attempts_exhausted`
toward a `needs_review` dead-letter path (spec §8). The exact Inngest API
names above are unverified against an installed `inngest` version — step 6
must confirm them before relying on this note; if `RetryAfterError` doesn't
exist as described, the fallback is `step.sleep(id, delayMs)` followed by a
manual re-invoke, which still consumes `decideRetry`'s output unchanged.

Step 6 should configure Inngest's own `retries` option as
`DEFAULT_RETRY_POLICY.maxAttempts - 1`, so the two ceilings — this policy's
`maxAttempts` and Inngest's `retries` — stay pinned to one number instead of
drifting independently.

## Consequences

- No attempt loop exists anywhere in `durable-ledger` today. Step 6 gains a
  decision function to call, not a footgun sitting unused in the package
  that a future change might accidentally wrap a second loop around.
- The retry budget is a single number (Inngest's `retries`, informed by
  `DEFAULT_RETRY_POLICY.maxAttempts`), not two multiplying numbers — the
  amplification failure mode described above cannot occur by construction.
- Backoff delay computation (`backoffDelayMs`) is still independently
  testable and reusable without pulling in Inngest — `retry-policy.test.ts`
  verifies the formula, jitter bounds, and server-hint handling with zero
  timers, zero real waiting, and zero Inngest dependency.
- If step 6 discovers Inngest's actual retry/backoff API can't cleanly
  consume a caller-supplied delay (e.g. no equivalent of `RetryAfterError`
  exists in the installed version), `decideRetry`'s `delayMs` becomes
  informational only (logged, not honored) rather than driving Inngest's
  wait directly — that's a step-6 integration detail to resolve against the
  real library, not a reason to reintroduce a local loop here.
