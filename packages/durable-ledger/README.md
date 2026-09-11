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

## Status: step 1 of 9

This package currently contains **only the double-entry ledger domain
model** — step 1 of the spec's own implementation order (§13):

1. **`src/domain/` (this step)** — `Money`, `LedgerAccount`, `LedgerEntry`,
   `PostingGroup`, and the balance/residual projections. No I/O.
2. Postgres schema (`ledger_entries`, `workflow_runs`) via Drizzle.
3. `posting.ts` — atomic, transactional posting of a group of entries.
4. A typed `pay-core` HTTP client with deterministic `Idempotency-Key`
   generation.
5. `isRetryable(error)` — the 503-retry / 402-terminal classification.
6. `payment.execute` workflow on Inngest (happy path + retries, no
   compensations yet).
7. Sagas: a hand-rolled step registry + compensation unwind, plus ledger
   reversal postings.
8. A thin Hono HTTP layer (`/workflows/*`, `/ledger/*`).
9. Tests land alongside each step above.

None of steps 2–9 exist yet in this package — no Postgres, no Inngest, no
HTTP, no saga/compensation logic.

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

## Roadmap

- [x] Domain: `Money`, `LedgerAccount`, `LedgerEntry`, `PostingGroup`,
      balance/residual projections
- [ ] Postgres schema + Drizzle adapters for `ledger_entries`
- [ ] Atomic multi-entry posting with a real DB transaction
- [ ] `pay-core` HTTP client + deterministic `Idempotency-Key`
- [ ] `isRetryable` retry policy
- [ ] `payment.execute` Inngest workflow (happy path + retries)
- [ ] Sagas + reversal postings (compensations)
- [ ] Hono HTTP layer
- [ ] Dockerfile + CI
