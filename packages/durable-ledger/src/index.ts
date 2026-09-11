/**
 * Public surface of `@apo/durable-ledger`. Steps 1-4 of the spec's
 * implementation order (docs/todo/02-durable-ledger.md §13) — the
 * double-entry ledger domain model, the Postgres schema for
 * `ledger_entries`, the `LedgerRepository` port + Postgres adapter for
 * atomic, idempotent posting, and a typed `pay-core` HTTP client with
 * deterministic `Idempotency-Key` generation. Use-cases and the rest of the
 * adapters (workflows, sagas, composition root) land in later steps.
 *
 * Not exported: `src/adapters/http/pay-core-schemas.ts`, `error-mapper.ts`,
 * and `fake-pay-core-server.ts` are internal/test-only, matching the
 * existing precedent of `mappers.ts`/`errors.ts` under
 * `src/adapters/persistence/drizzle/` — also internal, also not exported
 * here.
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

// Use-cases

// Adapters
export * from "./adapters/persistence/drizzle/schema.js";
export * from "./adapters/persistence/drizzle/pg-ledger-repository.js";
export * from "./adapters/http/pay-core-client.js";

// Workflow
export * from "./workflow/idempotency-key.js";
