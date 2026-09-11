# 6. Test `HttpPayCoreClient` against a hand-rolled `node:http` fake, not an in-process `pay-core` import

Date: 2026-09-11

## Status

Accepted

## Context

`packages/durable-ledger`'s `HttpPayCoreClient` (`src/adapters/http/pay-core-client.ts`)
needs tests that exercise real HTTP mechanics — status codes, headers,
timeouts, aborts, connection failures — against something that behaves like
`packages/pay-core`'s HTTP API. Importing `pay-core` in-process and driving
its Hono `app` directly (the way `pay-core`'s own `app.test.ts` does) was the
obvious first instinct, the same way reusing `pay-core`'s `Money` was the
obvious first instinct for the ledger domain (ADR-0005).

Three things rule that out:

- **Mechanical, same shape as ADR-0005:** `packages/pay-core/package.json`
  declares no `main`/`types`/`exports` field, so `@apo/pay-core` isn't
  resolvable as an importable workspace dependency by another package at
  all. Fixing that is a change to `pay-core`'s public shape made solely to
  satisfy this package's tests — out of this step's scope (see this step's
  plan, "Explicitly OUT of scope": no changes under `packages/pay-core/**`).
- **Even if it were importable, `SimulatorProvider` can't produce every
  scenario this client needs to prove.** `packages/pay-core/src/adapters/simulator/`
  drives its behavior through a directive grammar embedded in the
  `paymentMethodToken`/`providerRef` fields (`sim.decline.*`,
  `sim.fail_then_succeed.*`, `sim.timeout`, …) — but that grammar answers
  through pay-core's own use-case/domain layer, which always turns a decline
  into a `201` + `status: "failed"` response (see `create-payment.ts`) and a
  provider-unavailable failure into whatever the use-case propagates. It has
  no way to make `pay-core` itself emit an arbitrary capture-time `402`, a
  bare `500`, or hang indefinitely to prove a client-side timeout — those are
  transport-layer conditions, not domain ones. Pay-core's own tests for
  exactly those conditions use a `ScriptedProvider` defined locally inside
  `packages/pay-core/src/adapters/http/app.test.ts` and never exported, so
  even copying the technique means writing an equivalent fake, not reusing
  one.
- **A real `node:http` server over real sockets exercises the actual `fetch`
  / timeout / `AbortSignal` machinery honestly.** The most fragile part of
  `HttpPayCoreClient` is combining a request timeout with a caller-supplied
  `AbortSignal` via `AbortSignal.any(...)` and telling the two apart when
  either fires. An in-process call (calling a Hono `app.fetch()` directly,
  or driving `pay-core`'s use-cases without HTTP at all) never actually goes
  through `fetch`, DNS resolution, or a real socket, so it can't prove any
  of that — including the "connection refused" and "delayed response"
  scenarios, which need a real listening (or intentionally unreachable)
  port.

## Decision

`src/adapters/http/fake-pay-core-server.ts` starts a real `node:http` server
on an OS-assigned port (`listen(0, ...)`, so tests can run in parallel
without port collisions) and implements the wire contract transcribed from
`packages/pay-core/src/adapters/http/app.ts` and
`packages/pay-core/src/adapters/http/error-mapper.ts` for all five routes.
Every default route handler is individually overridable per test so a test
can force any status code, inject a `Retry-After` header, delay a response,
or destroy the socket outright — the shapes needed by the 16 scenarios in
`pay-core-client.test.ts`. It is test support only, not exported from
`src/index.ts`.

## Consequences

- Tests exercise `fetch`, timeouts, and `AbortSignal` combination honestly,
  against real sockets — the same class of bugs a real `pay-core` deployment
  could trigger (a hung connection, a reset socket) are reachable in tests.
- **Accepted risk: contract drift.** The fake's behavior is hand-maintained
  and can silently diverge from pay-core's real behavior if either side
  changes without the other being updated. Mitigated two ways: the fake's
  header comment cites the exact pay-core source files it mirrors, so a
  future change to either file has an obvious place to check for drift; and
  a real over-the-network check against the actual `pay-core` container
  (via `docker-compose.yml`) happens in a later step (durable-ledger spec
  §13 steps 6/8, once the workflow and HTTP layer exist to drive it) rather
  than here.
- No new coupling between `pay-core` and `durable-ledger` at compile time or
  at test time — the only integration surface remains pay-core's HTTP API,
  matching the spec and ADR-0005's reasoning.
- If `pay-core` ever gains a proper `exports` field and an exported test
  double for exactly this purpose, that's the trigger to revisit this
  decision, not before.
