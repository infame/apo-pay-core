# 9. Compensation routing by refusal reason, and a `WorkflowStep` seam to make it testable

Date: 2026-09-11

## Status

Accepted

## Context

Step 7 adds compensation logic to `payment.execute`: when a step fails
*terminally* after a prior step already had a real-world effect, undo it.
Two things had to be settled against the real, installed `inngest@4.20.0` /
`@inngest/test@1.0.0` before any of that logic could be written or tested.

**`@inngest/test`'s `InngestTestEngine` cannot execute any handler code
after a step fails — verified two independent ways.** A compensation lives
in the `catch` block surrounding the forward-path `step.run` calls, so this
is not a minor inconvenience; it makes the entire feature unobservable
through the harness step 6 already relies on for the happy path:

- **A live failing step halts the run.** `InngestTestRun`'s internal
  `"step-ran"` handler returns early when `result.step.error` is set — its
  own comment reads "if this is an error, we should stop. Later we model
  retries." There is no later invocation of the handler with that failure
  visible to `catch`; execution simply stops.
- **A pre-seeded failing step resolves as a false SUCCESS.** `@inngest/test`'s
  `steps: [{ id, handler: () => { throw … } }]` option is meant to let a
  test pre-arm a step's outcome without running the real handler. But the
  engine branches on `typeof result.data !== "undefined"` to decide whether
  a step succeeded, and `@inngest/test` supplies `data` as a Proxy-wrapped
  Promise — which always reports `typeof "object"`, never `"undefined"`,
  regardless of whether the handler threw. A spike confirmed this directly:
  a pre-seeded throwing handler produced a run that reported `{ ok: true }`
  with no error and no compensating step ever invoked.

**A `StepError`'s `.cause` loses custom fields — including `code`, not just
the fields ADR-0008 already knew about.** ADR-0008 established that only
`name`/`message`/`stack`/`code`/`cause` survive Inngest's own
`serializeError`, recursively. What step 7 needed and had to verify
separately: `StepError`'s constructor re-parses the serialized payload
through `jsonErrorSchema`, whose *nested*-`cause` branch is a **non-passthrough**
Zod object — so a cause's `code` field (added to `WorkflowStepFailedError`
specifically so same-process tests could assert on it) is stripped, even
though the *top-level* error's `code` is not. Concretely, given
`new StepError("capture", serializeError(nonRetriableError))`:
`stepError.stepId === "capture"` survives; `stepError.message` (copied from
the `NonRetriableError` that produced it) survives; but
`stepError.cause.code` and `stepError.cause.reason` do not. The refusal
reason (`terminal_error` / `attempts_exhausted` / `unclassified_error`) can
therefore only reliably cross this boundary as a substring of the
**top-level message**, not as a structured field — confirmed empirically
while writing `inngest-errors.test.ts`'s `StepError` round-trip case, not
assumed from the schema alone.

## Decision

**A single formatter/parser pair carries the refusal reason through the
message.** `permanentStepFailureMessage(stepName, reason)`
(`src/workflow/inngest-errors.ts`) is the one place that produces the string
`rethrowForInngest` throws; `stepFailureOf(error)` is the one place that
parses it back out, trying in order: (1) a live `WorkflowStepFailedError`
(same-process, custom fields intact), (2) its `.cause` being one (the shape
`rethrowForInngest` itself throws), (3) duck-typing a `stepId` property plus
regex-matching the formatter's pattern against the nearest message in the
chain (the real, production `StepError` shape). `WorkflowStepFailedError`
additionally carries `readonly code = reason` purely for (1)/(2) — it does
not help (3), since that's exactly the field this ADR just established gets
stripped, but it lets same-process tests assert
`error.cause.code === "terminal_error"` instead of substring-matching,
consistent with this repo's `code`-discriminator convention.

**Routing is keyed on `reason`, not on which step failed.** `planUnwind`
(`src/workflow/compensation.ts`) takes `{ reason, effects }` and returns one
of `"no_effects"` (rethrow verbatim), `"compensate"` (with the specific
actions to run), or `"needs_review"` (with why). Which step failed is
carried separately (for the failure message) but never drives the routing
decision itself — the *reason* a step failed is what determines whether
undoing prior effects is safe, regardless of which of the three steps it
was.

**Refund subsumes cancel.** `planUnwind` derives compensating actions from
the *latest* completed effect only, not one compensation per prior step:
once a payment is captured, only `refund-capture` runs. Issuing
`cancelPayment` on an already-captured payment is itself an illegal state
transition `pay-core` rejects with a 422, which would turn a *successful*
compensation into a spurious `needs_review` — compensating "too much" is not
free, it can manufacture a new failure.

**A `WorkflowStep` seam replaces Inngest's `ctx.step` in the function's own
logic**, to make any of this testable at all. `src/workflow/workflow-step.ts`
declares the one method (`run<T>(id, fn): Promise<Jsonify<...>>`) that
`payment.execute`'s logic actually uses; Inngest's real `step` argument
satisfies it structurally with zero casts (verified: assigning Inngest's own
handler `step` parameter to a `WorkflowStep`-typed variable type-checks
clean). `runPaymentExecute(step: WorkflowStep, ctx, deps)` is the entire
workflow body, independent of Inngest's own `ctx` object;
`createPaymentExecuteFunction` is now a one-line adapter calling it.
`FakeWorkflowStep` (`src/workflow/fake-workflow-step.ts`) implements
`WorkflowStep` directly and its `scriptFailure(stepId, error)` constructs
the *genuine* Inngest `StepError` shape via Inngest's own public
`StepError`/`serializeError` exports (not an approximation), so a scripted
failure behaves exactly like a real memoized failed step being replayed
into user code — without invoking the step's callback, matching real
Inngest's memoization semantics.

## Consequences

- `payment-execute.test.ts` keeps driving `createPaymentExecuteFunction`
  through `InngestTestEngine` for the happy path and for failures that occur
  *before* any effect exists (nothing to compensate either way, so the
  harness's inability to observe post-failure code doesn't matter there).
  `payment-execute-compensation.test.ts` drives `runPaymentExecute` directly
  through `FakeWorkflowStep` for everything that happens after a step fails
  with an existing effect to unwind — the only way to exercise that code at
  all with this test harness.
- The refusal-reason-in-a-message-substring design is real, load-bearing
  string coupling between `permanentStepFailureMessage` and `stepFailureOf`.
  A test round-trips every `RetryRefusalReason` through both, but a future
  change to either function in isolation risks silently breaking the other;
  there is no type-level guard against this because the underlying
  constraint (Inngest strips custom fields off a serialized cause) isn't
  something TypeScript can see.
- If `@inngest/test` ever ships real post-failure execution modeling (its
  own README already hints retries aren't modeled "yet"), the compensation
  suite gains a genuine engine-driven complement to
  `payment-execute-compensation.test.ts`'s `FakeWorkflowStep`-driven tests —
  it would not replace them, since `FakeWorkflowStep` also lets tests assert
  on exact call ordering and idempotency-key derivation more directly than
  driving a full engine would.
- If a future `inngest` major changes what `serializeError`/`StepError`
  preserve (e.g. adds passthrough to the nested-cause schema), the
  `stepFailureOf` shape-3 parsing path becomes unnecessary but remains
  harmless — shapes 1 and 2 already cover the case where custom fields
  survive. This ADR's specifics were confirmed against the installed
  `inngest@4.20.0`/`@inngest/test@1.0.0` sources directly (see
  `inngest-errors.test.ts`'s `StepError` round-trip test), same caveat as
  [ADR-0008](0008-inngest-v4-and-workflow-wiring.md)'s closing note.
