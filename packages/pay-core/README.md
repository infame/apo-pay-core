# @apo/pay-core

Deterministic payment core, one package (`packages/pay-core`) in the
**APO** (Autonomous Payment Orchestrator, hence the `@apo/*` package scope)
monorepo — a portfolio project. `durable-ledger`, `agent-orchestrator`,
`agent-evals`, and `orchestra` land as sibling packages in the same
workspace as they're built, not as separate repos — see
[ADR-0004](../../docs/adr/0004-monorepo-not-constellation.md) for why (an
earlier plan split these into five repos; the tooling cost of that turned
out to be real and repeated five times for no technical benefit).

Built to demonstrate backend correctness rather than breadth: an explicit
payment state machine, idempotent operations, and a provider-agnostic
integration boundary.

It is **not** a card processor — no PAN ever touches this service. It
orchestrates an external PSP behind a port, with an in-memory mock for local
runs. Full spec is kept local-only (`docs/todo/01-pay-core.md`, not in this
repo); the sections that matter are summarised below.

## Why this exists

Payment flows concentrate the problems interviewers actually care about:
consistency under retries, correct money handling, clean boundaries against
third-party systems, and testability. Design decisions are recorded as ADRs in
[`docs/adr`](../../docs/adr).

## Architecture: ports & adapters (hexagon)

The domain knows nothing about DB, HTTP, or the provider. It talks to the
outside world through **ports** (interfaces) implemented by **adapters**.

```
src/
  domain/      Payment aggregate + state machine, Money value object, events, typed errors
  ports/       PaymentProvider, PaymentRepository, IdempotencyStore (interfaces)
  app/         Use-cases (CreatePayment, CapturePayment, RefundPayment, …)
  adapters/
    mock/      In-memory PSP for demos/tests (deterministic decline hook)
    simulator/ Directive-driven PSP simulator (deterministic + weighted-random
               outcomes, incl. fail-then-succeed) — see below
    memory/    In-memory repository + idempotency store (tests only)
    persistence/drizzle/  Postgres repository + idempotency store (schema, migrations, adapters)
    http/      Hono routes, Zod schemas, error mapper
  composition-root.ts   Wires use-cases + adapters: `createPayCore(...)` (Postgres) and
                         `createInMemoryPayCore(...)` (tests/demos, no DB)
  config.ts    Zod-validated env config for the runnable service, fail-fast at boot
  main.ts      Process entrypoint: config → migrate → wire → serve → graceful shutdown
```

See [ADR-0002](../../docs/adr/0002-ports-and-adapters.md).

**Why ports, not "just import the driver":** every use-case in `src/app/`
depends on `PaymentRepository`/`IdempotencyStore`/`PaymentProvider` —
interfaces, not `pg` or a PSP SDK. That buys two things concretely, not
abstractly: the entire domain and use-case test suite runs against in-memory
adapters in milliseconds with no Docker, no network, no mocking framework —
and swapping the in-memory repository for the real Postgres one (or the mock
PSP for the simulator, or eventually a real processor) touches only
`src/adapters/` and `composition-root.ts`. Nothing in `src/domain/` or
`src/app/` has ever needed to change for any of those swaps to happen.

### Payment lifecycle

```
created ──authorize──▶ authorized ──capture──▶ captured ──refund──▶ partially_refunded ──▶ refunded
   │                        │
   └──▶ failed / canceled ◀─┘
```

We use `cancel`/`canceled` (as in Stripe), not the legacy "void".

The state machine is hand-written on `Payment` (`src/domain/payment.ts`) —
not a library (see [Considered and rejected](#considered-and-rejected) for
why not XState). Each transition method (`authorize`/`capture`/`refund`/
`cancel`/`fail`) guards its own preconditions explicitly (current status,
a shared `TERMINAL` set checked via `assertNotTerminal`) and throws a typed
`IllegalStateTransitionError` rather than silently no-op'ing or coercing;
terminal states (`refunded`/`failed`/`canceled`) have no outgoing
transitions at all. The domain event mapping that *does* use the
compiler for exhaustiveness lives one layer over, in the Postgres
adapter's event→payload mapper and the simulator's directive encoder
(`src/adapters/persistence/drizzle/mappers.ts`,
`src/adapters/simulator/directives.ts`) — both switch on a discriminated
union and assign the unreachable `default` case to a `const _exhaustive:
never`, so adding a new event type or simulator outcome without updating
every place that handles it is a build failure there, even though the
state machine itself is guard-clause style rather than a switch.

## Correctness properties

- **Money** is integer minor units with an explicit currency; cross-currency
  math throws. No floating point. (`src/domain/money.ts`)
- **State machine** rejects illegal transitions with typed errors; terminal
  states (`refunded`/`failed`/`canceled`) are final. (`src/domain/payment.ts`)
- **Idempotency**: `Idempotency-Key` + request fingerprint; retries return the
  original result, reuse with a different body is rejected.
  ([ADR-0003](../../docs/adr/0003-idempotency-and-outbox.md))
- **Atomic state + events**: `PaymentRepository.save(payment, events)` persists
  the aggregate and its domain events in one transaction — the reliable-write
  half of an outbox. Reliable _delivery_ is deliberately **not** built here: it
  is owned by Inngest in `durable-ledger`, so a dispatcher here would duplicate
  the mechanism. (See [ADR-0003](../../docs/adr/0003-idempotency-and-outbox.md).)

### Provider failures: terminal vs retryable

`PaymentProvider` errors split into two typed classes, both extending the
abstract `ProviderError` (`src/ports/payment-provider.ts`):

- **`ProviderDeclinedError`** — the provider looked at the request and said
  no (insufficient funds, fraud, expired card, …). `retryable = false`.
  Retrying the identical request cannot change the outcome. Maps to
  HTTP `402` (`src/adapters/http/error-mapper.ts`).
- **`ProviderUnavailableError`** — the provider couldn't answer (network
  error, 5xx, timeout). `retryable = true`. The request may succeed if
  retried. Maps to HTTP `503`, with a `Retry-After` header when the error
  carries a hint.

This split is not cosmetic: it's the contract the future `durable-ledger`
package's retry policy is built on — it retries `ProviderUnavailableError` and
gives up immediately on `ProviderDeclinedError`. `SimulatorProvider`
(`src/adapters/simulator/`) exercises both paths deterministically via a
directive grammar embedded in the (already-opaque) `paymentMethodToken` /
`providerRef` fields — e.g. `sim.decline.insufficient_funds`,
`sim.fail_then_succeed.2`, `sim.timeout` — plus a weighted-random mode for
exploratory testing. See `src/adapters/simulator/directives.ts` for the full
grammar and `simulator-provider.test.ts` for the retryable/terminal contract
tests.

## Persistence & concurrency

The Postgres adapters (`src/adapters/persistence/drizzle/`) implement
`PaymentRepository` and `IdempotencyStore` against three tables (`payments`,
`payment_events`, `idempotency_keys`) via [Drizzle](https://orm.drizzle.team/)
+ [`pg`](https://node-postgres.com/) (`node-postgres`, not `postgres.js` —
see below). Schema: `packages/pay-core/src/adapters/persistence/drizzle/schema.ts`;
generated migrations live in `drizzle/` and are applied by
`src/adapters/persistence/drizzle/migrator.ts`.

**Optimistic locking, not `SELECT … FOR UPDATE`.** Every mutating use-case
calls out to the (simulated) PSP *between* reading and writing a payment. A
row lock (`FOR UPDATE`) held across that external call would pin a pooled
connection for as long as the provider takes to respond — under a slow or
degraded provider, a handful of in-flight requests would exhaust the whole
pool for every other request, including ones touching unrelated payments.
Optimistic locking (`payments.version`, checked with `UPDATE … WHERE id = $1
AND version = $2`) only pays a cost on genuine write-write conflicts on the
*same* payment, which are rare, and never holds a connection during the PSP
round-trip. A conflict surfaces as a typed `OptimisticLockError`
(`src/adapters/persistence/drizzle/errors.ts`) — see
`pg-payment-repository.integration.test.ts` and
`concurrency.integration.test.ts` for the race this protects against.

**Transaction boundary: `AsyncLocalStorage`, not an explicit `UnitOfWork`
port.** `TransactionScope` (`transaction-scope.ts`) gives the composition
root a `scope.run(() => useCase.execute(cmd))` wrapper; inside that call
tree, `PgPaymentRepository` and `PgIdempotencyStore` both resolve the *same*
ambient transaction via `AsyncLocalStorage`, without either of them — or the
use-case itself — being passed a transaction handle explicitly. The
transaction begins lazily on the first *write* (`beginIfNeeded`), so reads
(`findById`) and the PSP call happen without a connection checked out. A
mutable "current transaction" field on the adapter instance was rejected: the
repository/store are singletons in the composition root, so a plain field
would be clobbered by concurrent requests; `AsyncLocalStorage` scopes the
handle to one call chain instead. This is also what makes the idempotency-key
insert and the payment write atomic: when a second concurrent request loses
the idempotency-key race (`(key, operation)` primary key violation), the
*whole* ambient transaction — including that request's payment insert —
rolls back, so there's no orphan row to reconcile; the composition root then
replays the winner's already-committed response.

**Local Docker Compose, not Testcontainers.** `docker-compose.yml` at the
monorepo root runs Postgres locally (`apo` for dev, `apo_test` for
integration tests, created by an initdb script) instead of spinning up
ephemeral containers via Testcontainers. Simpler CI/local setup and faster
iteration for a single-service repo; revisit if/when multiple services need
isolated, disposable databases per test run.

### Running against Postgres

```bash
docker compose up -d                              # from the monorepo root; postgres:17-alpine on :5433
DATABASE_URL=postgres://apo:apo@localhost:5433/apo pnpm --filter @apo/pay-core db:migrate

pnpm --filter @apo/pay-core test:integration       # real-Postgres suites (*.integration.test.ts)
```

`pnpm --filter @apo/pay-core test` (no flags) never touches Postgres —
`vitest.config.ts` excludes `*.integration.test.ts` — so the default test
run stays green without Docker. `test:integration` defaults
`TEST_DATABASE_URL` to the `apo_test` database above if unset, and fails
loudly (not silently skips) if Postgres isn't reachable.

`DATABASE_URL` / `TEST_DATABASE_URL` are documented for a local `.env` in the
monorepo root; values there are throwaway local-only credentials matching
`docker-compose.yml`.

## Running

```bash
pnpm install                       # from the monorepo root
pnpm --filter @apo/pay-core test   # unit tests, in-memory adapters, no external services
pnpm --filter @apo/pay-core typecheck
```

Requires Node 24+ and pnpm.

## Run it

`docker compose up --build` (from the monorepo root) is the one-command way
to bring the whole thing up: Postgres, boot-time migrations, and the
`pay-core` HTTP service listening on `:3000`.

| var | default | notes |
|---|---|---|
| `DATABASE_URL` | *(required)* | no default on purpose |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | must not be `127.0.0.1` in a container |
| `PAYMENT_PROVIDER` | `simulator` | `simulator` \| `mock` |
| `SIMULATOR_MODE` | `deterministic` | `deterministic` \| `random` |
| `SIMULATOR_SEED` | — | required iff `SIMULATOR_MODE=random` |
| `MIGRATE_ON_BOOT` | `true` | |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | |

Config is parsed once at boot (`src/config.ts`); a missing/invalid variable
fails fast with every issue listed in one message, instead of surfacing as a
`pg` connection error minutes later.

Demo sequence once the service is up (create → capture → get):

```bash
ID=$(curl -sS -X POST localhost:3000/payments \
      -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' \
      -d '{"amount":1200,"currency":"EUR","paymentMethodToken":"sim.ok"}' \
      | tee /dev/stderr | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

curl -sS -X POST "localhost:3000/payments/$ID/capture" \
      -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-2' -d '{}'

curl -sS "localhost:3000/payments/$ID"
```

Two known limitations, both intentional and documented rather than
oversights: `/healthz` is liveness-only — it doesn't ping the database, so a
healthy process with a dead DB connection still reports `200`. Boot-time
migrations (`MIGRATE_ON_BOOT`) are safe for a single replica only — there's
no advisory lock around them, so running more than one container against the
same database at boot could race; that's fine at one container, but would
need a dedicated one-shot migrate job if this ever scales out to multiple
replicas.

## Considered and rejected

Each of these was a live option; the point of writing down *why not* is
that the rejection was a decision, not an oversight.

- **Express.** Works, but as a portfolio signal it's the default everyone
  already reaches for — it demonstrates nothing about how you structure a
  service, only that you can wire middleware.
- **NestJS.** Nest's DI container and decorator layer add a layer of
  indirection that *hides* the architecture instead of expressing it — for
  a service this size, the hexagon (ports/adapters/use-cases,
  [ADR-0002](../../docs/adr/0002-ports-and-adapters.md)) already gives the
  same testability and swappability Nest's modules would, with the wiring
  visible in `composition-root.ts` instead of behind decorators.
- **Prisma.** Money code benefits from SQL you can read and reason about —
  the exact query behind an optimistic-lock `UPDATE ... WHERE version = $2`
  or a `(key, operation)` unique-constraint insert matters for the argument
  this repo is making. [Drizzle](https://orm.drizzle.team/) stays close to
  SQL and typed; Prisma's query engine and migration DSL trade some of that
  control for convenience this repo doesn't need.
- **XState.** A real FSM library buys more than this state machine needs
  (parallel/hierarchical states, actors) at the cost of another dependency
  and DSL between the reader and the actual transition logic. Seven states
  and a handful of guarded transitions read fine as plain methods on
  `Payment` — see [Payment lifecycle](#payment-lifecycle) above.
- **A dispatching transactional outbox.** `PaymentRepository.save` already
  gets the *reliable-write* half of an outbox for free (aggregate + domain
  events in one DB transaction). The *delivery* half — a poller relaying
  outbox rows to subscribers — is deliberately not built here: in this
  topology, Inngest fills that role in the (future) `durable-ledger` repo,
  so a dispatcher here would be a second mechanism doing the same job. See
  [ADR-0003](../../docs/adr/0003-idempotency-and-outbox.md).
- **Multi-capture** (`captured → captured`, capturing a second time to top
  up an earlier partial capture). Real acquirers support it, but it adds a
  second axis of partial-amount bookkeeping to the state machine for no
  narrative benefit here — partial capture is supported (you can capture
  less than the full authorization), it's just a single, final capture.
- **Testcontainers**, in favor of a plain `docker-compose.yml` Postgres for
  both local dev and CI — see [Persistence & concurrency](#persistence--concurrency)
  above for the tradeoff.

## Roadmap

- [x] Domain: Money, Payment state machine, domain events
- [x] Ports + in-memory adapters
- [x] `CreatePayment` use-case with idempotency
- [x] `CapturePayment` + `RefundPayment` use-cases
- [x] `CancelPayment` + `GetPayment` use-cases
- [x] Drizzle + Postgres adapters (optimistic locking, UNIQUE idempotency)
- [x] Acquirer simulator (deterministic fail-then-succeed; 402 vs 503)
- [x] Hono HTTP layer + Zod schemas + error mapper
- [x] Integration tests against a real Postgres
- [x] Dockerfile + `docker compose` runnable service
- [ ] CI
