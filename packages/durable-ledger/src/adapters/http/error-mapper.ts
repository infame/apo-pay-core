import type { PayCoreOperation } from "../../ports/pay-core-client.js";
import {
  PayCoreBadRequestError,
  PayCoreClientError,
  PayCoreDeclinedError,
  PayCoreIdempotencyConflictError,
  PayCoreIllegalStateError,
  PayCoreNotFoundError,
  PayCoreUnavailableError,
  PayCoreUnexpectedResponseError,
} from "../../ports/pay-core-errors.js";
import { errorEnvelopeSchema } from "./pay-core-schemas.js";

/**
 * Pure inverse of `packages/pay-core/src/adapters/http/error-mapper.ts` —
 * that file maps a domain error to an HTTP response; this one maps an HTTP
 * response back to a typed client error.
 */

export interface PayCoreErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly details?: ReadonlyArray<{
    readonly path: string;
    readonly message: string;
  }>;
}

/** Never throws. Returns undefined for empty/non-JSON/non-conforming bodies. */
export function parseErrorEnvelope(
  bodyText: string,
): PayCoreErrorEnvelope | undefined {
  if (bodyText.trim() === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) {
    return undefined;
  }
  const result = errorEnvelopeSchema.safeParse(parsed.error);
  return result.success ? result.data : undefined;
}

/**
 * "2" -> 2000ms. Absent, non-numeric, or an HTTP-date value (which pay-core
 * never emits but a proxy might) -> undefined. Never throws. Only accepts a
 * plain non-negative integer string of seconds — the exact shape pay-core's
 * own `error-mapper.ts` emits (`String(Math.ceil(ms / 1000))`).
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) {
    return undefined;
  }
  return Number(header.trim()) * 1000;
}

export interface RawErrorResponse {
  readonly status: number;
  readonly bodyText: string;
  readonly retryAfter: string | null;
}

/**
 * The full classification table, as one pure function. Given a non-2xx
 * response, returns the right `PayCoreClientError` subclass instance (does
 * not throw it — the caller decides when/how to throw).
 */
export function payCoreErrorFor(
  operation: PayCoreOperation,
  raw: RawErrorResponse,
): PayCoreClientError {
  const envelope = parseErrorEnvelope(raw.bodyText);
  const message = messageFor(operation, raw.status, envelope);
  const ctx = {
    operation,
    status: raw.status,
    payCoreCode: envelope?.code,
  };

  switch (raw.status) {
    case 400:
      return new PayCoreBadRequestError(message, ctx, envelope?.details);
    case 402:
      return new PayCoreDeclinedError(message, ctx);
    case 404:
      return new PayCoreNotFoundError(message, ctx);
    case 409:
      return new PayCoreIdempotencyConflictError(message, ctx);
    case 422:
      return new PayCoreIllegalStateError(message, ctx);
    case 503:
      return new PayCoreUnavailableError(
        message,
        ctx,
        parseRetryAfterMs(raw.retryAfter),
      );
    default:
      return new PayCoreUnexpectedResponseError(message, ctx);
  }
}

/**
 * Builds the error message from ONLY the operation name, status, and
 * pay-core's own `code`/`message` — never from the raw request or response
 * body, which could carry a `paymentMethodToken`. See
 * `error-mapper.test.ts`'s "never leaks a token" assertions.
 */
function messageFor(
  operation: PayCoreOperation,
  status: number,
  envelope: PayCoreErrorEnvelope | undefined,
): string {
  const base = `pay-core ${operation} failed with status ${status}`;
  if (envelope === undefined) {
    return `${base}`;
  }
  return `${base} (${envelope.code}): ${envelope.message}`;
}
