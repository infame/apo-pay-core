import { describe, expect, it } from "vitest";
import type { PayCoreClientError } from "../../ports/pay-core-errors.js";
import {
  PayCoreBadRequestError,
  PayCoreDeclinedError,
  PayCoreIdempotencyConflictError,
  PayCoreIllegalStateError,
  PayCoreNotFoundError,
  PayCoreUnavailableError,
  PayCoreUnexpectedResponseError,
} from "../../ports/pay-core-errors.js";
import {
  parseErrorEnvelope,
  parseRetryAfterMs,
  payCoreErrorFor,
} from "./error-mapper.js";

function envelope(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

describe("payCoreErrorFor — classification table", () => {
  const rows: ReadonlyArray<{
    readonly status: number;
    readonly klass: new (...args: never[]) => PayCoreClientError;
    readonly code: string;
    readonly retryable: boolean;
  }> = [
    {
      status: 400,
      klass: PayCoreBadRequestError,
      code: "pay_core_bad_request",
      retryable: false,
    },
    {
      status: 402,
      klass: PayCoreDeclinedError,
      code: "pay_core_declined",
      retryable: false,
    },
    {
      status: 404,
      klass: PayCoreNotFoundError,
      code: "pay_core_not_found",
      retryable: false,
    },
    {
      status: 409,
      klass: PayCoreIdempotencyConflictError,
      code: "pay_core_idempotency_conflict",
      retryable: false,
    },
    {
      status: 422,
      klass: PayCoreIllegalStateError,
      code: "pay_core_illegal_state",
      retryable: false,
    },
    {
      status: 503,
      klass: PayCoreUnavailableError,
      code: "pay_core_unavailable",
      retryable: true,
    },
    {
      status: 500,
      klass: PayCoreUnexpectedResponseError,
      code: "pay_core_unexpected_response",
      retryable: true,
    },
    {
      status: 502,
      klass: PayCoreUnexpectedResponseError,
      code: "pay_core_unexpected_response",
      retryable: true,
    },
    {
      status: 405,
      klass: PayCoreUnexpectedResponseError,
      code: "pay_core_unexpected_response",
      retryable: false,
    },
    {
      status: 415,
      klass: PayCoreUnexpectedResponseError,
      code: "pay_core_unexpected_response",
      retryable: false,
    },
    {
      status: 429,
      klass: PayCoreUnexpectedResponseError,
      code: "pay_core_unexpected_response",
      retryable: true,
    },
    {
      status: 408,
      klass: PayCoreUnexpectedResponseError,
      code: "pay_core_unexpected_response",
      retryable: true,
    },
  ];

  it.each(rows)(
    "status $status -> $code (retryable: $retryable)",
    ({ status, klass, code, retryable }) => {
      const err = payCoreErrorFor("capture_payment", {
        status,
        bodyText: envelope("some_code", "some message"),
        retryAfter: null,
      });
      expect(err).toBeInstanceOf(klass);
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
      expect(err.status).toBe(status);
      expect(err.payCoreCode).toBe("some_code");
    },
  );

  it("400 surfaces validation details from the envelope", () => {
    const bodyText = JSON.stringify({
      error: {
        code: "validation_failed",
        message: "Request validation failed",
        details: [{ path: "amount", message: "Required" }],
      },
    });
    const err = payCoreErrorFor("capture_payment", {
      status: 400,
      bodyText,
      retryAfter: null,
    });
    expect(err).toBeInstanceOf(PayCoreBadRequestError);
    expect((err as PayCoreBadRequestError).details).toEqual([
      { path: "amount", message: "Required" },
    ]);
  });

  it("409 surfaces pay-core's code and message", () => {
    const err = payCoreErrorFor("capture_payment", {
      status: 409,
      bodyText: envelope(
        "idempotency_conflict",
        "reused with a different request",
      ),
      retryAfter: null,
    });
    expect(err.payCoreCode).toBe("idempotency_conflict");
    expect(err.message).toContain("reused with a different request");
  });

  it("422 surfaces pay-core's code and message", () => {
    const err = payCoreErrorFor("capture_payment", {
      status: 422,
      bodyText: envelope(
        "illegal_state_transition",
        'Cannot capture a payment in state "failed"',
      ),
      retryAfter: null,
    });
    expect(err.payCoreCode).toBe("illegal_state_transition");
    expect(err.message).toContain("Cannot capture a payment");
  });

  it("503 with Retry-After: 2 sets retryAfterMs to 2000", () => {
    const err = payCoreErrorFor("capture_payment", {
      status: 503,
      bodyText: envelope("provider_unavailable", "Provider unavailable"),
      retryAfter: "2",
    }) as PayCoreUnavailableError;
    expect(err.retryAfterMs).toBe(2000);
  });

  it("503 with no Retry-After leaves retryAfterMs undefined", () => {
    const err = payCoreErrorFor("capture_payment", {
      status: 503,
      bodyText: envelope("provider_unavailable", "Provider unavailable"),
      retryAfter: null,
    }) as PayCoreUnavailableError;
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("503 with an HTTP-date Retry-After degrades to undefined without throwing", () => {
    expect(() =>
      payCoreErrorFor("capture_payment", {
        status: 503,
        bodyText: envelope("provider_unavailable", "Provider unavailable"),
        retryAfter: "Wed, 21 Oct 2015 07:28:00 GMT",
      }),
    ).not.toThrow();
    const err = payCoreErrorFor("capture_payment", {
      status: 503,
      bodyText: envelope("provider_unavailable", "Provider unavailable"),
      retryAfter: "Wed, 21 Oct 2015 07:28:00 GMT",
    }) as PayCoreUnavailableError;
    expect(err.retryAfterMs).toBeUndefined();
  });

  const malformedBodies: ReadonlyArray<[string, string]> = [
    ["empty body", ""],
    ["HTML body", "<html><body>502 Bad Gateway</body></html>"],
    ["invalid JSON", "{not json"],
    ["valid JSON without an error key", JSON.stringify({ ok: true })],
  ];

  it.each(malformedBodies)(
    "%s classifies by status alone, payCoreCode undefined, never throws",
    (_label, bodyText) => {
      expect(() =>
        payCoreErrorFor("get_payment", {
          status: 404,
          bodyText,
          retryAfter: null,
        }),
      ).not.toThrow();
      const err = payCoreErrorFor("get_payment", {
        status: 404,
        bodyText,
        retryAfter: null,
      });
      expect(err).toBeInstanceOf(PayCoreNotFoundError);
      expect(err.payCoreCode).toBeUndefined();
    },
  );

  it("never includes a request body or paymentMethodToken-shaped value in the error message", () => {
    const secretToken = "tok_super_secret_pm_12345";
    const bodyText = JSON.stringify({
      error: { code: "provider_declined", message: "Provider declined" },
      // A hostile/misbehaving upstream echoing the request body back;
      // the mapper must not surface it regardless.
      paymentMethodToken: secretToken,
    });
    const err = payCoreErrorFor("create_payment", {
      status: 402,
      bodyText,
      retryAfter: null,
    });
    expect(err.message).not.toContain(secretToken);
    expect(err.message).toContain("create_payment");
    expect(err.message).toContain("402");
  });
});

describe("parseErrorEnvelope", () => {
  it("parses a well-formed envelope", () => {
    const result = parseErrorEnvelope(
      envelope("provider_declined", "Declined"),
    );
    expect(result).toEqual({ code: "provider_declined", message: "Declined" });
  });

  it("returns undefined for an empty body", () => {
    expect(parseErrorEnvelope("")).toBeUndefined();
  });

  it("returns undefined for non-JSON", () => {
    expect(parseErrorEnvelope("<html></html>")).toBeUndefined();
  });

  it("returns undefined for JSON without an error key", () => {
    expect(parseErrorEnvelope(JSON.stringify({ ok: true }))).toBeUndefined();
  });

  it("never throws on malformed input", () => {
    expect(() => parseErrorEnvelope("{{{")).not.toThrow();
  });
});

describe("parseRetryAfterMs", () => {
  it("converts whole seconds to milliseconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
  });

  it("returns undefined for null", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it("returns undefined for non-numeric input", () => {
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });

  it("returns undefined for an HTTP-date value", () => {
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT")).toBeUndefined();
  });
});
