# 5. Duplicate the `Money` value object across `pay-core` and `durable-ledger`

Date: 2026-09-10

## Status

Accepted

## Context

`packages/durable-ledger`'s double-entry ledger model needs the exact same
kind of value object `packages/pay-core` already has: an integer,
minor-units, explicit-currency `Money` that throws rather than coerces on
invalid input or cross-currency arithmetic. Reusing `pay-core`'s
`src/domain/money.ts` instead of writing a second copy was the obvious
first instinct.

Two things rule that out, one mechanical and one architectural:

- **Mechanical:** `packages/pay-core/package.json` declares no
  `main`/`types`/`exports` field. As of this decision it isn't resolvable as
  an importable workspace dependency by another package at all — `import {
  Money } from "@apo/pay-core"` from `durable-ledger` would not resolve.
  Fixing that is possible, but it's a change to `pay-core`'s public shape
  made solely to satisfy an unrelated package, not something this task's
  scope covers.
- **Architectural:** even if it were resolvable, `docs/todo/02-durable-ledger.md`
  §1–§2 is explicit that `durable-ledger` talks to `pay-core` only over its
  HTTP API (`POST /payments`, `.../capture`, `.../refund`, `.../cancel`,
  `GET /payments/:id`) — never as an imported library. Importing `Money`
  as a shared type would quietly reintroduce a compile-time dependency
  between two packages the spec deliberately keeps decoupled to that one
  transport boundary, defeating the point of drawing the boundary there at
  all.

## Decision

`packages/durable-ledger/src/domain/money.ts` is its own copy of the
`Money` value object: same semantics (integer minor units, explicit
ISO-4217 currency, private constructor + static factories, throw not
coerce), same public API shape as `pay-core`'s, but a distinct class with
its own error types (`LedgerError` subclasses, not `pay-core`'s
`DomainError` subclasses — see the same reasoning applied to the error base
class, not written up separately since it's the identical trade-off).

The duplication is documented in three places so it reads as a decision,
not an oversight: this ADR, the header comment at the top of
`durable-ledger/src/domain/money.ts`, and `durable-ledger/README.md`.

## Consequences

- No new coupling between `pay-core` and `durable-ledger` at compile time;
  the only integration surface between them is the HTTP API, matching the
  spec.
- Two `Money` implementations must be kept in sync by hand if a bug fix or
  behavior change is needed in one (e.g. a rounding edge case). This is a
  real, accepted cost — mitigated by both copies being small, stable, and
  heavily tested.
- `instanceof` checks and error handling stay correctly scoped per package:
  a `durable-ledger` `CurrencyMismatchError` is never confused with
  `pay-core`'s, and vice versa.
- If a third package ever needs the same value object, that's the trigger
  to extract a genuinely shared library (with `pay-core` gaining a real
  `exports` field) rather than a third copy — revisit this decision then,
  not before.
