/**
 * Public surface of `@apo/durable-ledger`. Steps 1-3 of the spec's
 * implementation order (docs/todo/02-durable-ledger.md §13) — the
 * double-entry ledger domain model, the Postgres schema for
 * `ledger_entries`, and the `LedgerRepository` port + Postgres adapter for
 * atomic, idempotent posting. Use-cases and the rest of the adapters (HTTP
 * client, workflows, sagas, composition root) land in later steps.
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

// Use-cases

// Adapters
export * from "./adapters/persistence/drizzle/schema.js";
export * from "./adapters/persistence/drizzle/pg-ledger-repository.js";
