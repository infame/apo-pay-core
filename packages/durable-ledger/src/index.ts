/**
 * Public surface of `@apo/durable-ledger`. Steps 1-2 of the spec's
 * implementation order (docs/todo/02-durable-ledger.md §13) — the
 * double-entry ledger domain model, plus the Postgres schema for
 * `ledger_entries`. Ports, use-cases, and the rest of the adapters land in
 * later steps.
 */

// Domain
export * from "./domain/money.js";
export * from "./domain/errors.js";
export * from "./domain/account.js";
export * from "./domain/entry.js";
export * from "./domain/balances.js";

// Ports

// Use-cases

// Adapters
export * from "./adapters/persistence/drizzle/schema.js";
