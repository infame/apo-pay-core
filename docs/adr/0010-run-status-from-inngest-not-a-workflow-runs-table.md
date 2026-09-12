# 10. Read `payment.execute` run status from Inngest's own API, not a `workflow_runs` table

Date: 2026-09-11

## Status

Accepted

## Context

Step 8 adds the first HTTP surface to `packages/durable-ledger`, including a
way to check on a triggered `payment.execute` run. Spec §7 lists
`workflow_runs` as a possible table alongside `ledger_entries`, and every
prior step that touched the schema (step 2's `ledger_entries` design,
step 6/7's workflow code) explicitly deferred it, reasoning "Inngest is the
source of truth on steps until step 8." This step is step 8 — the deferral
runs out here, and the table has to be either built or deliberately not
built.

Two things had to be verified against a **live** Inngest dev server
(`inngest-cli@1.44.0`) before deciding, not assumed from the SDK's types
alone:

- **`inngest.send()` returns only a server-assigned event id** — a ULID,
  unrelated to any id the caller might want to use. There is no SDK-level
  API to look up a run by a caller-supplied correlation id, and Inngest's
  own REST API rejects a non-ULID id outright (`GET /v1/events/my-id/runs`
  → `400 Invalid event ID`, confirmed directly). So a `workflow_runs` table
  keyed on a caller-chosen id is the *only* way to give a caller a lookup
  key they actually chose — Inngest's API structurally cannot do that.
- **The `NEEDS_REVIEW_MARKER` string (`src/workflow/compensation.ts`,
  [ADR-0009](0009-compensation-routing-and-the-workflow-step-seam.md))
  is directly readable through Inngest's own API on a failed run**,
  verified by triggering a real compensation-failure scenario against the
  live dev server and reading the literal string
  `payment.execute needs_review: compensation "compensate-authorize" failed
  while unwinding step "capture"` back out of `GET /v1/runs/:id`'s `output`
  field. The dead-letter visibility this package's README already promised
  step 8 comes for free from the engine — no separate write path is needed
  to produce it.
- **A *successful* run's `output` is empty** (`""`), confirmed twice against
  the live dev server. `payment.execute`'s own `PaymentExecuteResult` is
  therefore not retrievable through Inngest's API at all, table or no table
  — building `workflow_runs` would not fix this without a dedicated write
  from inside `payment.execute` itself, which is a change to already-heavily-tested
  step 6/7 code for a capability nothing has asked for yet.
- **Two of Inngest's own endpoints can disagree**, and the more specific one
  wins: `/v1/events/:id/runs` can still report `Completed` with
  `ended_at: null` a moment after `/v1/runs/:id` already reports `Running`
  for the same run (both cached independently — `metadata.cached_until` is
  ≈15s and ≈3s respectively). A `WorkflowRuns` reader has to make two
  sequential calls and let the second, more specific one override the
  first, or it can report a stale status.

## Decision

`GET /workflows/:eventId` reads run status live from Inngest's own REST API
through a new port, `WorkflowRuns` (`src/ports/workflow-runs.ts`), backed by
`InngestWorkflowRuns` (`src/adapters/inngest/inngest-workflow-runs.ts`). No
`workflow_runs` table, no migration, no write path added to
`payment-execute.ts`/`compensation.ts`. `findByEventId` makes the two
sequential calls described above and lets `/v1/runs/:id`'s answer win;
`needsReview` is derived by checking a failed run's `output` for
`NEEDS_REVIEW_MARKER`, imported from `compensation.ts` rather than
re-declared, so the two can never drift apart.

Both endpoints answer HTTP `200` even for what they consider their own
errors (an invalid event id, a missing run) — the *response envelope's*
`status`/`error` fields carry the real outcome, not the transport status
code. `InngestWorkflowRuns` branches on the envelope, never on `res.ok`.

The caller-chosen-id limitation (above) is accepted, not solved: the
`202`-returned `eventId` is the only handle a client gets, and losing it
means losing the ability to poll that run. This is judged acceptable for a
portfolio-scale demo service, not a production payment gateway.

## Consequences

- No schema change, no migration, and zero edits to `src/domain/**` or the
  already-stabilized `payment-execute.ts`/`compensation.ts` step 6/7 logic
  for this step — the entire status-reading capability is new files behind
  a new port.
- `GET /workflows/:eventId` requires Inngest to be reachable and answers
  `503 workflow_engine_unavailable` when it isn't — the same shape as the
  ledger routes requiring Postgres and the workflow requiring `pay-core`.
- **A completed run's result payload is not retrievable through this
  endpoint** — only a failed run's message is. `WorkflowRunSnapshot` does
  not promise a `result` field; documented in the durable-ledger README
  rather than silently omitted.
- **`queued` is permanently ambiguous** for a bad id vs. a just-sent event
  whose run hasn't been created yet: both currently produce an empty
  `data: []` from `/v1/events/:id/runs`. Documented, not resolved — a
  caller cannot distinguish "give it a second" from "this event id never
  existed" purely from this endpoint.
- If a future requirement needs a caller-chosen correlation id, offline
  status reads (without Inngest reachability), or the completed-run result
  payload, that is the trigger to build `workflow_runs` — at that point it
  is a targeted, justified addition, not a default reached for out of habit
  the way this ADR explicitly declined to reach for it now.
