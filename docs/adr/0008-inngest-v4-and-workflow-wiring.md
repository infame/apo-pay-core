# 8. Inngest v4, and two wiring rules the type system won't catch for you

Date: 2026-09-11

## Status

Accepted

## Context

Step 6 wires `packages/durable-ledger`'s `payment.execute` workflow to a real,
installed `inngest` package for the first time (ADR-0007 scoped the retry
*decision* but explicitly left the actual Inngest API unverified). Three
things had to be settled against the real, installed library rather than
assumed from documentation or a prior version's shape.

**Why `inngest@^4.20.0`, not v3.** The architect staged `inngest@^4.20.0` and
`@inngest/test@^1.0.0` in `package.json` ahead of this step (`pnpm-lock.yaml`
already resolves both). v4 is the current major at the time this package was
built, and — load-bearing for this step specifically — v4 ships `eventType(name,
{ schema })` (`node_modules/inngest/components/triggers/triggers.js`), a
first-class, Standard-Schema-compatible event-type helper that lets
`src/workflow/events.ts` define `paymentExecuteRequested` from the same Zod
schema (`paymentExecuteRequestedSchema`) used to validate incoming event data,
with no separate hand-written trigger-name string to keep in sync. There was
no reason to pin to an older major only to lose that.

**The `Inngest.Any` / generic-parameter type-inference trap.** `Inngest.createFunction`
is typed as `Inngest.CreateFunction<TClient>`, a generic whose inferred
`ctx` shape (`event`, `step`, `runId`, `attempt`, …) depends on `TClient`
resolving to a *concrete* `Inngest<TClientOpts>` instantiation. Two
superficially reasonable alternatives both break this:

- A function signature like `function createPaymentExecuteFunction(deps: { inngest: Inngest.Any })`
  — `Inngest.Any` is declared as `type Any = Inngest` (a bare, ungenerically-parameterized
  reference), which resolves `TClientOpts` to its default (`ClientOptions`)
  rather than to whatever the caller's actual client was constructed with.
- A generic parameter, `function createPaymentExecuteFunction<T extends Inngest.Any>(deps: { inngest: T })`
  — looks like it should preserve the concrete type, but because `deps.inngest`
  is read from a plain options object (not `Inngest`'s own methods), inference
  here collapses the same way: TypeScript ends up widening the effective
  `ctx` type inside the handler to `any` in both cases.

Either way, `event.data`, `step`, `runId`, and `attempt` all silently become
`any` inside the handler — no compile error at the call site, just ~28
`@typescript-eslint/no-unsafe-*` violations scattered through the handler
body (verified locally: this was the exact failure mode hit before settling
on the fix below, not a hypothetical).

**Why the retry-classification catch must live inside `step.run`, not around
it.** `decideRetry` (`src/workflow/retry-policy.ts`) is built entirely on
`error instanceof PayCoreClientError`. Inngest does not propagate the
original thrown `Error` object out of a failed `step.run(...)` call to code
*outside* that step — a step failure crosses an internal
serialize/deserialize boundary (`inngest`'s own `serializeError`,
`helpers/errors.js`) before the surrounding handler (or, in tests, before
`@inngest/test`'s `t.execute()`) ever sees it. Only `name`, `message`,
`stack`, `code`, and `cause` survive that boundary — custom fields do not
(see `WorkflowStepFailedError.reason`/`.stepName`, which do not survive, and
`RetryAfterError.retryAfter`, which does not either; confirmed empirically
against `@inngest/test@1.0.0` while writing `payment-execute.test.ts`). If
`rethrowForInngest`'s `decideRetry` call happened in a `try/catch` wrapping
`step.run(...)` instead of inside the step's own callback, `instanceof
PayCoreClientError` would always be `false` by the time it ran, and every
failure — retryable or not — would silently misclassify as
`unclassified_error`.

## Decision

- Use `inngest@^4.20.0` / `@inngest/test@^1.0.0` as already staged; no
  further dependency changes.
- `src/workflow/payment-execute.ts`'s `PaymentExecuteDeps.inngest` is typed
  as the plain, non-generic `Inngest` (imported as `import type { Inngest } from "inngest"`)
  — NOT `Inngest.Any`, NOT a generic type parameter. `createPaymentExecuteFunction`'s
  return type is deliberately left uninferred (no explicit return-type
  annotation on the function) — annotating it collapses the same inference
  TypeScript would otherwise correctly derive from `deps.inngest.createFunction(...)`'s
  own generic resolution. Verified directly: this combination type-checks
  clean with zero `no-unsafe-*` suppressions; both alternatives above do not.
- Every `step.run(...)` callback in `payment-execute.ts` wraps its
  `payCore`/`ledger` call in its own `try { ... } catch (error) { rethrowForInngest(...) }`,
  never a `try/catch` around the `await step.run(...)` call site.
  `rethrowForInngest`'s own doc comment (`src/workflow/inngest-errors.ts`)
  states this rule; this ADR records *why* it's load-bearing, not just that
  it's a convention.
- The `"triggers"` field on `createFunction`'s options is `{ triggers: [{ event: paymentExecuteRequested }] }`
  — an array of trigger objects with an `event` key, NOT the bare `EventType`
  instance directly (`InngestFunction.Trigger<TName>` is
  `{ event: TName | EventType<TName, …>, if?: string } | { cron: string }`,
  confirmed against `node_modules/inngest/components/InngestFunction.d.ts`).

## Consequences

- `payment-execute.ts` and its dependents type-check with no `any`, no
  `@ts-ignore`, and no `eslint-disable` for unsafe-* rules — the whole point
  of getting the `Inngest` typing right up front.
- Any future workflow file in this package (step 7's saga orchestration, a
  future `payment.refund`/`payment.cancel`) should copy this file's import
  shape (`import type { Inngest } from "inngest"`, no generic parameter, no
  annotated return type) rather than rediscovering the trap independently.
- Tests (`payment-execute.test.ts`) assert failures by `.name`/`.message`
  content on the plain object `@inngest/test` returns from a failed
  `t.execute()`, never by `instanceof RetryAfterError`/`NonRetriableError` —
  those instanceof checks are always `false` against that returned object,
  for the same serialization-boundary reason described above. This is
  `@inngest/test`'s behavior specifically (confirmed as of `@inngest/test@1.0.0`);
  it does not indicate anything is wrong with the workflow itself.
- If a future `inngest` major changes `Inngest.CreateFunction`'s generic
  shape, `InngestFunction.Trigger`'s union shape, or what survives
  `serializeError`, this ADR's specifics (not just its conclusions) need
  re-verification — they were confirmed against the installed
  `inngest@4.20.0`/`@inngest/test@1.0.0` `.d.ts`/`.js` sources directly, not
  against public documentation, which can drift from a specific pinned
  version.
