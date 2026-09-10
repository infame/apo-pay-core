import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mapError, HttpError } from "./error-mapper.js";
import { DomainError } from "../../domain/errors.js";
import {
  IllegalStateTransitionError,
  AmountExceededError,
  PaymentNotFoundError,
} from "../../domain/errors.js";
import { IdempotencyConflictError } from "../../ports/idempotency-store.js";
import {
  ProviderDeclinedError,
  ProviderUnavailableError,
} from "../../ports/payment-provider.js";

/** Exercises the generic `DomainError` fallback branch — no other concrete
 * subclass exists in `src/domain/errors.ts` besides the three explicitly
 * mapped ones. */
class OtherDomainError extends DomainError {
  readonly code = "other_domain_error";
}

describe("mapError", () => {
  it("maps a ZodError to 400 validation_failed with path/message-only details", () => {
    const schema = z.object({ amount: z.number().positive() });
    const result = schema.safeParse({ amount: -5 });
    if (result.success) throw new Error("expected parse to fail");

    const mapped = mapError(result.error);

    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("validation_failed");
    expect(mapped.body.error.details).toBeDefined();
    for (const detail of mapped.body.error.details ?? []) {
      expect(Object.keys(detail).sort()).toEqual(["message", "path"]);
    }
    expect(mapped.body.error.details?.[0]?.path).toBe("amount");
  });

  it("maps an HttpError to its own status and code", () => {
    const err = new HttpError(400, "missing_idempotency_key", "boom");
    const mapped = mapError(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("missing_idempotency_key");
    expect(mapped.body.error.message).toBe("boom");
  });

  it("maps an IdempotencyConflictError to 409 idempotency_conflict", () => {
    const mapped = mapError(new IdempotencyConflictError("key-1"));
    expect(mapped.status).toBe(409);
    expect(mapped.body.error.code).toBe("idempotency_conflict");
  });

  it("maps a PaymentNotFoundError to 404 payment_not_found", () => {
    const err = new PaymentNotFoundError("pay_1");
    const mapped = mapError(err);
    expect(mapped.status).toBe(404);
    expect(mapped.body.error.code).toBe(err.code);
    expect(mapped.body.error.code).toBe("payment_not_found");
  });

  it("maps an IllegalStateTransitionError to 422 illegal_state_transition", () => {
    const err = new IllegalStateTransitionError("captured", "capture");
    const mapped = mapError(err);
    expect(mapped.status).toBe(422);
    expect(mapped.body.error.code).toBe(err.code);
    expect(mapped.body.error.code).toBe("illegal_state_transition");
  });

  it("maps an AmountExceededError to 422 amount_exceeded", () => {
    const err = new AmountExceededError("too much");
    const mapped = mapError(err);
    expect(mapped.status).toBe(422);
    expect(mapped.body.error.code).toBe(err.code);
    expect(mapped.body.error.code).toBe("amount_exceeded");
  });

  it("maps any other DomainError subclass to 422 with its own code", () => {
    const err = new OtherDomainError("something else went wrong");
    const mapped = mapError(err);
    expect(mapped.status).toBe(422);
    expect(mapped.body.error.code).toBe("other_domain_error");
  });

  it("maps a ProviderDeclinedError to 402 provider_declined", () => {
    const mapped = mapError(new ProviderDeclinedError("insufficient funds"));
    expect(mapped.status).toBe(402);
    expect(mapped.body.error.code).toBe("provider_declined");
    expect(mapped.headers).toBeUndefined();
  });

  it("maps a ProviderUnavailableError with retryAfterMs to 503 + Retry-After header", () => {
    const mapped = mapError(new ProviderUnavailableError("timeout", 2500));
    expect(mapped.status).toBe(503);
    expect(mapped.body.error.code).toBe("provider_unavailable");
    expect(mapped.headers).toEqual({ "Retry-After": "3" });
  });

  it("maps a ProviderUnavailableError without retryAfterMs to 503, no Retry-After header", () => {
    const mapped = mapError(new ProviderUnavailableError("timeout"));
    expect(mapped.status).toBe(503);
    expect(mapped.body.error.code).toBe("provider_unavailable");
    expect(mapped.headers).toBeUndefined();
  });

  it("maps an unknown error to a generic 500 that leaks nothing about the cause", () => {
    const err = new Error("connection to postgres://user:pw@host failed");
    const mapped = mapError(err);

    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });

    const serialized = JSON.stringify(mapped.body);
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("stack");
  });
});
