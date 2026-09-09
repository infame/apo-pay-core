# @apo/pay-core

Deterministic payment core, part of **APO** (Autonomous Payment
Orchestrator, hence the `@apo/*` package scope) — a portfolio project built
as a constellation of separate repos rather than one big monorepo, each
prefixed `apo-` on GitHub so they're identifiable as related at a glance:
this one (`apo-pay-core`), plus `apo-durable-ledger`, `apo-agent-orchestrator`,
`apo-agent-evals`, and `apo-orchestra` (head repo — cross-repo orchestration,
demo, deploy) as they land. This repo's own `package.json` is still named
`autonomous-payment-orchestrator` internally (it predates the multi-repo
split) — that's a local pnpm-workspace root name, not a link to the umbrella.

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
    memory/    In-memory repository + idempotency store (tests only)
    persistence/drizzle/  (roadmap) Postgres repository + idempotency store
    acquirer/  (roadmap) deterministic acquirer simulator (fail-then-succeed)
    http/      (roadmap) Hono routes, Zod schemas, error mapper
```

See [ADR-0002](../../docs/adr/0002-ports-and-adapters.md).

### Payment lifecycle

```
created ──authorize──▶ authorized ──capture──▶ captured ──refund──▶ partially_refunded ──▶ refunded
   │                        │
   └──▶ failed / canceled ◀─┘
```

We use `cancel`/`canceled` (as in Stripe), not the legacy "void".

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

## Running

```bash
pnpm install                       # from the monorepo root
pnpm --filter @apo/pay-core test   # unit tests, in-memory adapters, no external services
pnpm --filter @apo/pay-core typecheck
```

Requires Node 24+ and pnpm.

## Roadmap

- [x] Domain: Money, Payment state machine, domain events
- [x] Ports + in-memory adapters
- [x] `CreatePayment` use-case with idempotency
- [x] `CapturePayment` + `RefundPayment` use-cases
- [ ] `CancelPayment` + `GetPayment` use-cases
- [ ] Drizzle + Postgres adapters (optimistic locking, UNIQUE idempotency)
- [ ] Acquirer simulator (deterministic fail-then-succeed; 402 vs 503)
- [ ] Hono HTTP layer + Zod schemas + error mapper
- [ ] Integration tests against a real Postgres
- [ ] Dockerfile + CI
