# @apo/durable-ledger

Durable execution and a double-entry ledger, one package
(`packages/durable-ledger`) in the **APO** (Autonomous Payment Orchestrator)
monorepo — a portfolio project. It sits alongside `@apo/pay-core`
(`packages/pay-core`) in the same pnpm workspace; see
[ADR-0004](../../docs/adr/0004-monorepo-not-constellation.md) for why they're
one repository rather than a constellation of five.

`pay-core` gives you operations that are **safe to retry**. `durable-ledger`
uses that to build reliable, resumable multi-step payment workflows on top
— talking to `pay-core` only over its HTTP API, never as an imported
library, and appending immutable double-entry postings to record where money
moved. That boundary is intentional: this package durably orchestrates
`pay-core`, it does not own payment state. Full spec is kept local-only
(`docs/todo/02-durable-ledger.md`, not in this repo); the sections that
matter are summarised below.

## Status: step 5 of 9

This package currently contains the double-entry ledger domain model, the
Postgres schema and migration plumbing for `ledger_entries`, the
`LedgerRepository` port + Postgres adapter for atomic, idempotent posting, a
typed `pay-core` HTTP client with deterministic `Idempotency-Key` generation,
and a pure retry-decision policy — steps 1-5 of the spec's own implementation
order (§13):

1. **`src/domain/`** — `Money`, `LedgerAccount`, `LedgerEntry`,
   `PostingGroup`, and the balance/residual projections. No I/O.
2. **Postgres schema (`ledger_entries`) via Drizzle** — its own `ledger`
   Postgres schema, append-only via a `BEFORE UPDATE OR DELETE` trigger.
3. **`LedgerRepository` port + `PgLedgerRepository`** — atomic, idempotent
   posting of a `PostingGroup`, plus the read paths
   (`findByOperationId`/`findByPaymentId`/`findByAccount`/`getBalance`). See
   "Posting & idempotency" below.
4. **`HttpPayCoreClient`** — a typed HTTP client for `pay-core`'s five
   routes, deterministic `Idempotency-Key` generation, and error
   classification. See "Talking to pay-core" below.
5. **`decideRetry`/`isRetryable` (this step)** — a pure retry-decision policy
   over the error classification from step 4: retry or not, and after how
   long. See "Retrying pay-core calls" below.
6. `payment.execute` workflow on Inngest (happy path + retries, no
   compensations yet).
7. Sagas: a hand-rolled step registry + compensation unwind, plus ledger
   reversal postings.
8. A thin Hono HTTP layer (`/workflows/*`, `/ledger/*`).
9. Tests land alongside each step above.

None of steps 6–9 exist yet in this package — no Inngest, no HTTP layer, no
saga/compensation logic, no composition root.

## The domain model

Double-entry, not a mutable balance column: every operation posts **at
least two entries whose amounts sum to zero across debit and credit**, and
an account's balance is a *projection* over the append-only entry log, never
a stored field. See `docs/todo/02-durable-ledger.md` §3 for the full
rationale (auditability, no lost history, no lost updates under
concurrency).

- `LedgerAccount` — `customer:<id>`, `merchant:<id>`, or
  `acquirer_clearing` (a clearing/liability account, no subject).
- `LedgerEntry` — one debit or credit line, always positive, sign lives in
  `direction`.
- `PostingGroup.create(...)` — the **only** way to construct a valid set of
  entries; it enforces every invariant (≥2 entries, at least one debit and
  one credit, positive amounts, one currency, balanced totals, no duplicate
  `(account, direction)` pair, valid UUIDs) and throws a specific typed
  `LedgerError` subclass otherwise. `forCapture`/`forRefund` are the two
  concrete postings this package currently knows how to build (§3.3):
  capture debits `acquirer_clearing` and credits the merchant; refund is
  the exact reverse.
- `balances.ts` — pure projections (`balanceOf`, `balanceSheet`,
  `residuals`, `isBalanced`, `assertZeroSum`) over any
  `Iterable<LedgerEntry>`. No port, no I/O — a later Postgres-backed step
  feeds these a query result the same way today's tests feed them an
  in-memory array.

**Sign convention (§3.4):** a balance is `SUM(credit) − SUM(debit)`. After a
capture, `merchant:<id>` is `+amount` and `acquirer_clearing` is
`−amount` — the clearing account runs *negative*. That's correct, not a
bug: it's a liability/transit account, not a store of value, and its
negative balance is exactly offset by the merchant's positive one. See the
named test in `balances.test.ts` asserting this.

Every entry also carries `entryType` (`"capture" | "refund" | "reversal"`)
and `reversesOperationId`. Both fields exist now, ahead of the reversal
*logic* landing in step 7, so the Postgres schema in step 2 is a mechanical
transcription of this shape rather than a migration later.

## Posting & idempotency

`LedgerRepository.post(group)` (`src/ports/ledger-repository.ts`,
`PgLedgerRepository` in `src/adapters/persistence/drizzle/pg-ledger-repository.ts`)
appends every entry of a `PostingGroup` atomically and idempotently on
`operationId`.

- **Why a Postgres advisory lock, not just "insert and catch the unique
  violation".** The schema's `(operation_id, account, direction)` unique
  index (`schema.ts`) only stops a second insert that collides on all three
  columns. Two concurrent `post()` calls for the same `operationId` but
  *disjoint* accounts — one posting to `merchant:a`, a conflicting one to
  `merchant:b` — share no row the index could collide on, so relying on the
  index alone would let both inserts succeed and leave two different
  postings under one `operationId`. `post()` instead takes a
  session-scoped `pg_advisory_xact_lock(namespace, hashtext(operationId))`
  before it reads or writes anything for that operation, inside the same
  transaction as the read-then-insert — so the second caller for a given
  `operationId` always sees the first caller's committed rows before
  deciding whether to no-op or insert. The unique index stays as a backstop
  (`DuplicatePostingError` in `errors.ts`) for the case that lock
  serialization is itself broken, not as the primary mechanism.
- **Why the fingerprint excludes `id`/`createdAt`.** `PostingGroup.create`
  mints a fresh `randomUUID()` per entry on every call
  (`src/domain/entry.ts`), so a retried workflow step legitimately
  reconstructs "the same" logical group with different row ids and a
  different timestamp. `fingerprintOf` (`src/domain/posting-fingerprint.ts`)
  builds its identity from the fields that make a posting *logically* the
  same — account, direction, amount, currency, paymentId, entryType,
  reversesOperationId — sorted so entry order doesn't matter either.
  `post()` compares the attempted group's fingerprint against the stored
  entries' fingerprint: equal means "this is the same retry, return the
  stored result"; different means `PostingConflictError` — the caller's key
  logic changed under a stable `operationId`, which is a bug, not a retry.
- **`getBalance` vs `balanceOf`.** `balances.ts`'s `balanceOf` is the pure
  specification of what a balance *means* (`SUM(credit) − SUM(debit)` over
  an `Iterable<LedgerEntry>`, no I/O). `PgLedgerRepository.getBalance` is
  the pushed-down implementation of the same computation as a SQL
  `SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END)`
  aggregate, so a balance query doesn't have to pull every row for an
  account into the application just to sum them. The two are pinned
  together by integration tests asserting
  `getBalance(a, c)` equals `balanceOf(await findByAccount(a, c), a, c)` on
  the same data — including the `acquirer_clearing` negative-sign
  convention (see "Sign convention" above).

## Talking to pay-core

`HttpPayCoreClient` (`src/adapters/http/pay-core-client.ts`) implements the
`PayCoreClient` port (`src/ports/pay-core-client.ts`) against pay-core's five
HTTP routes: `POST /payments`, `.../capture`, `.../refund`, `.../cancel`,
`GET /payments/:id`. `baseUrl` is required with no default; the per-request
timeout defaults to `DEFAULT_REQUEST_TIMEOUT_MS` (10s) and can be overridden
globally (constructor) or per call (`RequestOptions.timeoutMs`).

**Gotcha, do not "fix" this:** a `201` response from `createPayment` can
carry `status: "failed"` in the body. pay-core's `CreatePayment` use-case
catches a provider decline internally and persists a failed payment rather
than raising an HTTP error — see `packages/pay-core/src/app/create-payment.ts`.
`HttpPayCoreClient.createPayment` resolves normally in that case; it does
not throw. The pinning test is named accordingly in
`pay-core-client.test.ts`.

Error classification (`src/ports/pay-core-errors.ts`), the caller-side
mirror of pay-core's own "Provider failures: terminal vs retryable" split
(`packages/pay-core/README.md`):

| HTTP status | Error class | `retryable` |
|---|---|---|
| network failure (no response) | `PayCoreNetworkError` | true |
| request timeout | `PayCoreTimeoutError` | true |
| caller's own `AbortSignal` fired | `PayCoreRequestCanceledError` | false |
| 400 | `PayCoreBadRequestError` | false |
| 402 | `PayCoreDeclinedError` | false |
| 404 | `PayCoreNotFoundError` | false |
| 409 | `PayCoreIdempotencyConflictError` | false |
| 422 | `PayCoreIllegalStateError` | false |
| 503 | `PayCoreUnavailableError` | true |
| any other non-2xx | `PayCoreUnexpectedResponseError` | `status >= 500 \|\| status === 429 \|\| status === 408` |
| 2xx with a body that fails schema validation | `PayCoreMalformedResponseError` | false |

`stepIdempotencyKey(runId, stepName)` (`src/workflow/idempotency-key.ts`) is
`sha256(runId + ":" + stepName)`, hex-encoded. It's deterministic on
purpose: an Inngest step re-run (step 6) produces the identical key, so
pay-core replays its stored idempotency record instead of performing a
second effect (double-charge, double-refund, …).

**Exactly-once gap, out of scope for this client.** pay-core's
`CreatePayment` calls the provider *before* persisting the payment (see
`create-payment.ts`). If `createPayment` times out, `PayCoreTimeoutError`
is correctly `retryable: true` in the sense that retrying with the same
`Idempotency-Key` guarantees "at most one recorded payment" — but it does
NOT guarantee "at most one PSP hold": the first attempt may have already
authorized with the provider before the response was lost. Closing that gap
(e.g. checking provider state before a second authorize) is a property of
`pay-core` itself, not something this HTTP client can paper over, and is
recorded here so it isn't silently assumed away.

## Retrying pay-core calls

`decideRetry(error, attempt, options?)` (`src/workflow/retry-policy.ts`) is a
**pure decision function**: given a failed call's error and how many attempts
have already happened, it answers "retry or not, and after how long" — it
does not sleep, loop, or perform the retry itself.

**Formula** (equal jitter, server hint as a floor):

```
exp      = min(baseDelayMs * backoffMultiplier ** (attempt - 1), maxDelayMs)
jittered = exp / 2 + rng() * (exp / 2)        // ∈ [exp/2, exp)
delayMs  = min(round(max(jittered, hint)), maxDelayMs)
```

With `DEFAULT_RETRY_POLICY` (`maxAttempts: 4, baseDelayMs: 500,
backoffMultiplier: 2, maxDelayMs: 30_000`):

| Attempt | Delay range (no server hint) |
|---|---|
| 1 | 250 – 500ms |
| 2 | 500ms – 1s |
| 3 | 1 – 2s |
| 4th failure | `attempts_exhausted` — no attempt 5 |

`maxAttempts: 4` isn't arbitrary: the simulator's `sim.fail_then_succeed`
directive defaults to 1 failure (`DEFAULT_FAILURES` in
`packages/pay-core/src/adapters/simulator/directives.ts`), so a default
policy comfortably absorbs the demo's own flakiness while keeping the
worst-case wall-clock under ~4 seconds absent a server hint.

A `PayCoreUnavailableError` carrying `retryAfterMs` (from pay-core's
`Retry-After` header) acts as a **floor** via `max(jittered, hint)` — it can
only extend a wait, never shorten one that's already escalated, and a
sub-second hint (which serializes to the header value `"0"`, since pay-core
emits `Math.ceil(ms / 1000)`) safely falls through to normal backoff instead
of forcing a hot loop.

An error that isn't a `PayCoreClientError` at all (a `LedgerError`, a
`PostingConflictError`, a plain bug) is never retried —
`reason: "unclassified_error"` — because every error `HttpPayCoreClient` can
actually throw is already funneled through `payCoreErrorFor` into a
`PayCoreClientError`; anything else is a different kind of failure that
won't un-happen on a retry.

**Inngest owns the retry loop here — do not add a `withRetry` helper.** This
package deliberately ships no attempt loop. Step 6's Inngest workflow calls
`decideRetry` inside a `step.run(...)`, and Inngest's own step-retry
mechanism (durable across a process crash, unlike an in-process
`setTimeout`) does the actual waiting and re-invoking — rethrow the server's
hint as Inngest's own retry-delay signal on `shouldRetry: true`, and a
non-retriable signal otherwise, routing `terminal_error`/`unclassified_error`
to compensation and `attempts_exhausted` to `needs_review` (see
[ADR-0007](../../docs/adr/0007-inngest-owns-the-retry-loop.md) for the full
reasoning, including the retry-amplification math a nested loop would cause).
Step 6 should configure Inngest's own `retries` option as
`DEFAULT_RETRY_POLICY.maxAttempts - 1` so the two ceilings stay pinned
together — **unverified against an actual installed `inngest` version**; step
6 must confirm the real API (e.g. whether `NonRetriableError`/
`RetryAfterError` exist under those names/signatures) before relying on this.

## Why a duplicated `Money`, not shared with `@apo/pay-core`

`src/domain/money.ts` is a deliberate copy of `pay-core`'s `Money`, not
an oversight. Two independent reasons: `pay-core` has no
`main`/`types`/`exports` field in its `package.json`, so nothing outside
that package can actually `import` from it as a workspace dependency today;
and even if it could, sharing the type would quietly couple two packages
that the spec (§1, §2) deliberately keeps talking to each other only over
HTTP. Recorded as [ADR-0005](../../docs/adr/0005-duplicate-money-across-packages.md);
revisit if a third package ever needs the same value object.

## Running

```bash
pnpm install                            # from the monorepo root
pnpm --filter @apo/durable-ledger test  # unit tests, no external services
pnpm --filter @apo/durable-ledger typecheck
pnpm --filter @apo/durable-ledger lint
```

Requires Node 24+ and pnpm.

### Running the integration tests

```bash
docker compose up -d                                    # from the monorepo root; postgres:17-alpine on :5433
DATABASE_URL=postgres://apo:apo@localhost:5433/apo pnpm --filter @apo/durable-ledger db:migrate

pnpm --filter @apo/durable-ledger test:integration       # real-Postgres suites (*.integration.test.ts)
```

`pnpm --filter @apo/durable-ledger test` (no flags) never touches Postgres —
`vitest.config.ts` excludes `*.integration.test.ts` — so the default test
run stays green without Docker. `test:integration` defaults
`TEST_DATABASE_URL` to the `apo_test` database above if unset, and fails
loudly (not silently skips) if Postgres isn't reachable.

This package's tables live in their own `ledger` Postgres schema, not
`public`, even though they share one Postgres instance with `pay-core`
(`docker-compose.yml`): namespace isolation, so `ledger_entries` can never
collide with one of pay-core's tables, and migration-journal isolation, so
applying this package's migrations (tracked at
`ledger.__drizzle_migrations`) can never affect pay-core's own migration
journal or vice versa. See `src/adapters/persistence/drizzle/schema.ts` for
the full rationale.

## Roadmap

- [x] Domain: `Money`, `LedgerAccount`, `LedgerEntry`, `PostingGroup`,
      balance/residual projections
- [x] Postgres schema (`ledger_entries`, append-only, own `ledger` schema)
- [x] Atomic multi-entry posting with a real DB transaction
- [x] `pay-core` HTTP client + deterministic `Idempotency-Key`
- [x] `decideRetry`/`isRetryable` retry policy (pure — no loop; Inngest owns
      that in step 6, see ADR-0007)
- [ ] `payment.execute` Inngest workflow (happy path + retries)
- [ ] Sagas + reversal postings (compensations)
- [ ] Hono HTTP layer
- [ ] Dockerfile + CI
