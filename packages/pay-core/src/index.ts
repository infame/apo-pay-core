/**
 * Public surface of `@apo/pay-core`: domain, ports, use-cases, the in-memory
 * test/demo adapters, the Postgres composition root, and the Hono HTTP
 * adapter (`createApp`, `mapError`, the request schemas).
 */

// Domain
export * from "./domain/money.js";
export * from "./domain/payment.js";
export * from "./domain/events.js";
export * from "./domain/errors.js";

// Ports
export * from "./ports/payment-repository.js";
export * from "./ports/idempotency-store.js";
export * from "./ports/payment-provider.js";

// Use-cases
export * from "./app/create-payment.js";
export * from "./app/capture-payment.js";
export * from "./app/refund-payment.js";
export * from "./app/cancel-payment.js";
export * from "./app/get-payment.js";

// In-memory adapters (tests / demos)
export * from "./adapters/memory/in-memory-payment-repository.js";
export * from "./adapters/memory/in-memory-idempotency-store.js";
export * from "./adapters/mock/mock-provider.js";
export * from "./adapters/simulator/simulator-provider.js";
export * from "./adapters/simulator/directives.js";

// Postgres composition root
export * from "./composition-root.js";

// HTTP adapter
export * from "./adapters/http/app.js";
export * from "./adapters/http/error-mapper.js";
export * from "./adapters/http/schemas.js";
