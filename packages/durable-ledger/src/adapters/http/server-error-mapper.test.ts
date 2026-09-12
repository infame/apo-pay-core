import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mapError, HttpError } from "./server-error-mapper.js";
import {
  CurrencyMismatchError,
  InvalidAccountError,
  InvalidMoneyError,
  LedgerImbalanceError,
} from "../../domain/errors.js";
import { WorkflowEngineUnavailableError } from "../../ports/workflow-runs.js";
import { Money } from "../../domain/money.js";

describe("mapError", () => {
  it("maps a ZodError to 400 validation_failed, with details carrying only path/message, never the submitted value", () => {
    const schema = z.object({ amount: z.number().positive() });
    const secretValue = -999999;
    const result = schema.safeParse({ amount: secretValue });
    if (result.success) throw new Error("expected parse to fail");

    const mapped = mapError(result.error);

    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("validation_failed");
    expect(mapped.body.error.details).toBeDefined();
    for (const detail of mapped.body.error.details ?? []) {
      expect(Object.keys(detail).sort()).toEqual(["message", "path"]);
    }
    const serialized = JSON.stringify(mapped.body);
    expect(serialized).not.toContain(String(secretValue));
  });

  it("maps an HttpError to its own carried status and code", () => {
    const err = new HttpError(400, "invalid_json", "boom");
    const mapped = mapError(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("invalid_json");
    expect(mapped.body.error.message).toBe("boom");
  });

  it("maps InvalidAccountError to 400 (a malformed request, not a rejected domain transition)", () => {
    const err = new InvalidAccountError("bad account");
    const mapped = mapError(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("invalid_account");
  });

  it("maps InvalidMoneyError to 400", () => {
    const err = new InvalidMoneyError("bad money");
    const mapped = mapError(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("invalid_money");
  });

  it("maps CurrencyMismatchError to 400", () => {
    const err = new CurrencyMismatchError("USD", "EUR");
    const mapped = mapError(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("currency_mismatch");
  });

  it("maps WorkflowEngineUnavailableError to 503", () => {
    const err = new WorkflowEngineUnavailableError("Inngest unreachable");
    const mapped = mapError(err);
    expect(mapped.status).toBe(503);
    expect(mapped.body.error.code).toBe("workflow_engine_unavailable");
  });

  it("maps any other LedgerError subclass to 422 with its own code", () => {
    const err = new LedgerImbalanceError(
      new Map([["USD", Money.of(5, "USD")]]),
    );
    const mapped = mapError(err);
    expect(mapped.status).toBe(422);
    expect(mapped.body.error.code).toBe("ledger_imbalance");
  });

  it("maps an unrecognized error to a generic 500, never leaking the underlying message", () => {
    const secretMessage = "unexpected: database credentials leaked here";
    const mapped = mapError(new Error(secretMessage));
    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(JSON.stringify(mapped.body)).not.toContain(secretMessage);
  });

  it("maps a thrown non-Error value to the same generic 500", () => {
    const mapped = mapError("just a string, not even an Error");
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe("internal_error");
  });
});
