/**
 * Public surface of `@apo/durable-ledger`. Steps 1-8 of the spec's
 * implementation order (docs/todo/02-durable-ledger.md §13) — the
 * double-entry ledger domain model (including `PostingGroup.reversalOf`),
 * the Postgres schema for `ledger_entries`, the `LedgerRepository` port +
 * Postgres adapter for atomic, idempotent posting, a typed `pay-core` HTTP
 * client with deterministic `Idempotency-Key` generation, a pure
 * retry-decision policy, the `payment.execute` Inngest workflow (happy path
 * + retries + compensations — see ADR-0007, ADR-0008, ADR-0009), and a thin
 * Hono HTTP layer (`/workflows/*`, `/ledger/*`) with a live-read
 * `WorkflowRuns` port over Inngest's own REST API (no local `workflow_runs`
 * table).
 *
 * Not exported: `config.ts`/`main.ts` are bootstrap-only, matching
 * pay-core's own precedent (`packages/pay-core/src/index.ts` doesn't export
 * either). `src/adapters/http/pay-core-schemas.ts`, `error-mapper.ts` (the
 * pay-core-client-facing one), and `fake-pay-core-server.ts` were already
 * internal/test-only before this step and remain so. New this step,
 * deliberately NOT exported: `src/adapters/http/fake-workflow-runs.ts` and
 * `src/adapters/inngest/fake-inngest-api-server.ts` are test-only doubles,
 * matching the existing precedent of `mappers.ts`/`errors.ts` under
 * `src/adapters/persistence/drizzle/` and this package's own
 * `fake-pay-core-client.ts`/`fake-workflow-step.ts` — also internal, also
 * not exported here.
 */

// Domain
export * from "./domain/money.js";
export * from "./domain/errors.js";
export * from "./domain/account.js";
export * from "./domain/entry.js";
export * from "./domain/balances.js";
export * from "./domain/posting-fingerprint.js";

// Ports
export * from "./ports/ledger-repository.js";
export * from "./ports/pay-core-client.js";
export * from "./ports/pay-core-errors.js";
export * from "./ports/workflow-runs.js";

// Use-cases

// Adapters
export * from "./adapters/persistence/drizzle/schema.js";
export * from "./adapters/persistence/drizzle/pg-ledger-repository.js";
export * from "./adapters/http/pay-core-client.js";
export * from "./adapters/inngest/client.js";
export * from "./adapters/inngest/inngest-workflow-runs.js";
export * from "./adapters/memory/in-memory-ledger-repository.js";
export * from "./adapters/http/app.js";
export * from "./adapters/http/server-schemas.js";
export * from "./adapters/http/server-error-mapper.js";
export * from "./adapters/http/ledger-view.js";

// Workflow
export * from "./workflow/idempotency-key.js";
export * from "./workflow/operation-id.js";
export * from "./workflow/retry-policy.js";
export * from "./workflow/events.js";
export * from "./workflow/inngest-errors.js";
export * from "./workflow/workflow-step.js";
export * from "./workflow/compensation.js";
export * from "./workflow/payment-execute.js";

// Composition root
export * from "./composition-root.js";
