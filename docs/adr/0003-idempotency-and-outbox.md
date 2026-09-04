# 3. Idempotency keys and the transactional outbox

Date: 2026-07-01

## Status

Accepted (amended 2026-07-11: the outbox *dispatcher* is descoped from
`pay-core` — reliable delivery is owned by Inngest in `durable-ledger`. The
atomic state+events write is kept. See `docs/todo/01-pay-core.md` §11.)

## Context

Two hard problems in any payment system:

1. **Duplicate requests.** Network retries, double-clicks, and at-least-once
   webhook delivery mean the same "create payment" can arrive more than once. A
   naive handler double-charges.
2. **Dual writes.** After changing state we must tell the outside world
   (notify the merchant, update a ledger). "Update the DB, then make an external
   call" is not atomic: a crash between the two leaves the system inconsistent.

## Decision

**Idempotency keys.** Mutating requests carry an `Idempotency-Key`. We store the
result keyed by it plus a fingerprint of the request body. A retry with the same
key + body returns the stored result without re-executing; a retry with the same
key + a *different* body is rejected (`IdempotencyConflictError`). See
`packages/pay-core/src/app/create-payment.ts` and
`packages/pay-core/src/ports/idempotency-store.ts`.

**Transactional outbox — write half only.** `PaymentRepository.save` persists
the aggregate state *and* its domain events in one transaction. Either both
commit or neither does. This removes the dual-write hazard on the *write* side:
we only ever write to our own database inside the request.

The *delivery* half — a background dispatcher relaying outbox rows to
subscribers — is deliberately **not** built in `pay-core`. In this topology
reliable, durable delivery is provided by Inngest in `durable-ledger`; a
dispatcher here would be a second mechanism in the same place. A dispatcher is
added only if a consumer appears outside Inngest.

## Consequences

- `save(payment, events)` is the atomic unit; the in-memory adapter mirrors this
  contract so tests exercise the same shape as production.
- Events carry a stable id so downstream (Inngest steps) can dedupe — which
  closes the loop with decision (1): effects are idempotent end to end.
- No `dispatched_at` marker / polling worker lives in `pay-core`. This is a
  conscious scope cut, not a gap (see `docs/todo/01-pay-core.md` §11).
