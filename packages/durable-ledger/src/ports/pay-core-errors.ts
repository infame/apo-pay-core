import type { PayCoreOperation } from "./pay-core-client.js";

/**
 * Typed errors raised by any `PayCoreClient` implementation. Deliberately
 * *not* `LedgerError` subclasses (`src/domain/errors.ts`) — same reasoning as
 * `LedgerPersistenceError`
 * (`src/adapters/persistence/drizzle/errors.ts`): `LedgerError` models
 * invariants the ledger domain itself enforces; a failed HTTP call to
 * `pay-core` is a transport failure, not one of those.
 *
 * `retryable` is the contract `isRetryable(error)` (step 5) and the workflow
 * retry policy (step 6) are built on — it mirrors, from the caller's side,
 * the terminal-vs-retryable split `pay-core`'s own README documents under
 * "Provider failures: terminal vs retryable"
 * (`packages/pay-core/README.md`): a `ProviderDeclinedError` maps to `402`
 * here becomes `PayCoreDeclinedError` (`retryable = false`); a
 * `ProviderUnavailableError` maps to `503` here becomes
 * `PayCoreUnavailableError` (`retryable = true`).
 *
 * Error messages built from `PayCoreErrorContext`/`RawErrorResponse` data
 * must never include a request body or `paymentMethodToken` — only the
 * operation name, HTTP method/path, status, and pay-core's own
 * `code`/`message` from its error envelope. Pinned by
 * `src/adapters/http/error-mapper.test.ts`.
 */
export interface PayCoreErrorContext {
  readonly operation: PayCoreOperation;
  readonly status: number | undefined;
  readonly payCoreCode: string | undefined;
  readonly cause?: unknown;
}

export abstract class PayCoreClientError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;
  readonly operation: PayCoreOperation;
  readonly status: number | undefined;
  readonly payCoreCode: string | undefined;

  constructor(message: string, ctx: PayCoreErrorContext) {
    super(message, ctx.cause === undefined ? undefined : { cause: ctx.cause });
    this.name = new.target.name;
    this.operation = ctx.operation;
    this.status = ctx.status;
    this.payCoreCode = ctx.payCoreCode;
  }
}

/** `fetch` itself failed before any response arrived (DNS, connection refused, socket reset). Retrying may hit a healthy instance. */
export class PayCoreNetworkError extends PayCoreClientError {
  readonly code = "pay_core_network_error";
  readonly retryable = true;
}

/** The request's own deadline (`timeoutMs`) elapsed with no response. The operation may have completed server-side; the caller's retry (via idempotency key) is what makes this safe. */
export class PayCoreTimeoutError extends PayCoreClientError {
  readonly code = "pay_core_timeout";
  readonly retryable = true;
  readonly timeoutMs: number;

  constructor(message: string, ctx: PayCoreErrorContext, timeoutMs: number) {
    super(message, ctx);
    this.timeoutMs = timeoutMs;
  }
}

/** The CALLER's own `AbortSignal` fired, not the request timeout. The caller asked to stop — retrying would contradict that, so this is terminal. */
export class PayCoreRequestCanceledError extends PayCoreClientError {
  readonly code = "pay_core_canceled";
  readonly retryable = false;
}

/** HTTP 400 — pay-core rejected the request shape itself (validation_failed / missing_idempotency_key / invalid_json). Same bytes will fail the same way again. */
export class PayCoreBadRequestError extends PayCoreClientError {
  readonly code = "pay_core_bad_request";
  readonly retryable = false;
  readonly details?: ReadonlyArray<{
    readonly path: string;
    readonly message: string;
  }>;

  constructor(
    message: string,
    ctx: PayCoreErrorContext,
    details?: ReadonlyArray<{
      readonly path: string;
      readonly message: string;
    }>,
  ) {
    super(message, ctx);
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/** HTTP 402 — the PSP looked at the request and said no (mirrors `ProviderDeclinedError`, pay-core README "terminal"). Retrying the identical request cannot change the outcome. */
export class PayCoreDeclinedError extends PayCoreClientError {
  readonly code = "pay_core_declined";
  readonly retryable = false;
}

/** HTTP 404 — no payment exists for the given id. Won't start existing on retry. */
export class PayCoreNotFoundError extends PayCoreClientError {
  readonly code = "pay_core_not_found";
  readonly retryable = false;
}

/** HTTP 409 — the same `Idempotency-Key` was reused with a different request body. A caller-side bug, not a transient condition; retrying with the same (wrong) body repeats the conflict. */
export class PayCoreIdempotencyConflictError extends PayCoreClientError {
  readonly code = "pay_core_idempotency_conflict";
  readonly retryable = false;
}

/** HTTP 422 — the payment's current state forbids the requested transition (a `DomainError` in pay-core). The state won't un-happen on retry. */
export class PayCoreIllegalStateError extends PayCoreClientError {
  readonly code = "pay_core_illegal_state";
  readonly retryable = false;
}

/** HTTP 503 — pay-core (or its PSP) couldn't answer (mirrors `ProviderUnavailableError`, pay-core README "retryable"). The request may succeed if retried, optionally after `retryAfterMs`. */
export class PayCoreUnavailableError extends PayCoreClientError {
  readonly code = "pay_core_unavailable";
  readonly retryable = true;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    ctx: PayCoreErrorContext,
    retryAfterMs?: number,
  ) {
    super(message, ctx);
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

/**
 * Any non-2xx status this client has no specific mapping for. `retryable` is
 * computed from `status`, not a fixed literal like the other classes: a
 * bare 5xx may recover on the server side without any change on our end, so
 * it's worth another try; an unmapped 4xx is a request-side problem that
 * retrying identically won't fix. 429/408 are not emitted by pay-core today
 * (no rate limiting, no server-side request timeout), but are included as
 * retryable in case a future proxy/ingress in front of pay-core ever emits
 * them — "try again" is the correct reading of both regardless of source.
 */
export class PayCoreUnexpectedResponseError extends PayCoreClientError {
  readonly code = "pay_core_unexpected_response";
  readonly retryable: boolean;

  constructor(message: string, ctx: PayCoreErrorContext) {
    super(message, ctx);
    this.retryable =
      ctx.status !== undefined &&
      (ctx.status >= 500 || ctx.status === 429 || ctx.status === 408);
  }
}

/** A 2xx response body didn't match the expected schema. A pay-core/client contract drift, not something a retry fixes. */
export class PayCoreMalformedResponseError extends PayCoreClientError {
  readonly code = "pay_core_malformed_response";
  readonly retryable = false;
}
