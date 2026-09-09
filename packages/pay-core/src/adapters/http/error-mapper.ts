import { ZodError } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DomainError, PaymentNotFoundError } from "../../domain/errors.js";
import { IdempotencyConflictError } from "../../ports/idempotency-store.js";
import {
  ProviderError,
  ProviderUnavailableError,
} from "../../ports/payment-provider.js";

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** Only ever set for validation failures: path + message, never the submitted value. */
    readonly details?: ReadonlyArray<{
      readonly path: string;
      readonly message: string;
    }>;
  };
}

/** A transport-level failure raised directly by the HTTP adapter (bad header, bad JSON, …). */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface MappedError {
  readonly status: ContentfulStatusCode;
  readonly body: ErrorBody;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Translates any error thrown by a use-case or the HTTP adapter itself into a
 * status code + JSON envelope. Pure and Hono-independent (takes `unknown`,
 * returns plain data) so it's directly unit-testable.
 *
 * The `PaymentNotFoundError` (404) case is redundant with the generic
 * `DomainError` fallback (`.code` is already `payment_not_found`), but it's
 * spelled out to match the mapping table exactly and to keep the 404 case
 * explicit rather than implicit in fallback ordering.
 */
export function mapError(err: unknown): MappedError {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "validation_failed",
          message: "Request validation failed",
          details: err.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
    };
  }

  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  if (err instanceof IdempotencyConflictError) {
    return {
      status: 409,
      body: { error: { code: "idempotency_conflict", message: err.message } },
    };
  }

  if (err instanceof PaymentNotFoundError) {
    return {
      status: 404,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  if (err instanceof DomainError) {
    return {
      status: 422,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  if (err instanceof ProviderError) {
    const status: ContentfulStatusCode = err.retryable ? 503 : 402;
    const code = err.retryable ? "provider_unavailable" : "provider_declined";
    const retryAfterMs =
      err instanceof ProviderUnavailableError ? err.retryAfterMs : undefined;
    const headers =
      retryAfterMs === undefined
        ? undefined
        : { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) };
    return {
      status,
      body: { error: { code, message: err.message } },
      ...(headers === undefined ? {} : { headers }),
    };
  }

  return {
    status: 500,
    body: {
      error: { code: "internal_error", message: "Internal server error" },
    },
  };
}
