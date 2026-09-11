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

## Status: step 3 of 9

This package currently contains the double-entry ledger domain model, the
Postgres schema and migration plumbing for `ledger_entries`, and the
`LedgerRepository` port + Postgres adapter for atomic, idempotent posting —
steps 1-3 of the spec's own implementation order (§13):

1. **`src/domain/`** — `Money`, `LedgerAccount`, `LedgerEntry`,
   `PostingGroup`, and the balance/residual projections. No I/O.
2. **Postgres schema (`ledger_entries`) via Drizzle** — its own `ledger`
   Postgres schema, append-only via a `BEFORE UPDATE OR DELETE` trigger.
3. **`LedgerRepository` port + `PgLedgerRepository` (this step)** — atomic,
   idempotent posting of a `PostingGroup`, plus the read paths
   (`findByOperationId`/`findByPaymentId`/`findByAccount`/`getBalance`). See
   "Posting & idempotency" below.
4. A typed `pay-core` HTTP client with deterministic `Idempotency-Key`
   generation.
5. `isRetryable(error)` — the 503-retry / 402-terminal classification.
6. `payment.execute` workflow on Inngest (happy path + retries, no
   compensations yet).
7. Sagas: a hand-rolled step registry + compensation unwind, plus ledger
   reversal postings.
8. A thin Hono HTTP layer (`/workflows/*`, `/ledger/*`).
9. Tests land alongside each step above.

None of steps 4–9 exist yet in this package — no `pay-core` HTTP client, no
Inngest, no HTTP layer, no saga/compensation logic, no composition root.

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
- [ ] `pay-core` HTTP client + deterministic `Idempotency-Key`
- [ ] `isRetryable` retry policy
- [ ] `payment.execute` Inngest workflow (happy path + retries)
- [ ] Sagas + reversal postings (compensations)
- [ ] Hono HTTP layer
- [ ] Dockerfile + CI
