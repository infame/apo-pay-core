# 2. Ports and adapters, with Hono over NestJS

Date: 2026-07-01

## Status

Accepted (amended 2026-07-11: HTTP framework is Hono, not Fastify — aligning
with the shared stack in `docs/todo/00-overview.md` §3, local-only, not
in this repo. Paths updated for the monorepo layout under `packages/pay-core/`.
Amended 2026-09-10: the umbrella project this stack is shared across is one
monorepo, not a "constellation" of repos — see
[ADR-0004](0004-monorepo-not-constellation.md).)

## Context

The gateway integrates with external PSPs and a database, and must stay testable
and correct under retries. Two structural questions: how to isolate the domain
from IO, and which HTTP framework to build on.

## Decision

**Hexagonal (ports & adapters).** The domain (`packages/pay-core/src/domain`)
and use-cases (`packages/pay-core/src/app`) depend only on interfaces
(`packages/pay-core/src/ports`): `PaymentProvider`, `PaymentRepository`,
`IdempotencyStore`. Concrete implementations (`packages/pay-core/src/adapters`)
— Postgres, in-memory, a mock PSP — are injected at the edge. The domain never
imports a vendor SDK.

**Hono, not NestJS.** For a service this size, Nest's DI container and decorator
layer add indirection that hides the architecture rather than expressing it.
Hono is a thin, type-safe HTTP layer; the structure of the app is our own
explicit wiring. Validation is done with Zod at the boundary (types via
`z.infer`), keeping a single source of truth for request/response shapes. Hono
is also the shared HTTP choice across the whole monorepo (`00-overview §3`).

## Consequences

- Use-cases are unit-testable with in-memory adapters; no container, no mocks of
  a framework. The test suite runs in milliseconds.
- Swapping the in-memory repo for Drizzle/Postgres, or the mock provider for a
  real PSP, touches only `packages/pay-core/src/adapters` and the composition
  root.
- We forgo Nest's batteries-included features (guards, interceptors, modules).
  If the surface grows substantially, this decision is worth revisiting.
