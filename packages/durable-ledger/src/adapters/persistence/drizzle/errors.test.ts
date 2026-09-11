import { describe, expect, it } from "vitest";
import { DuplicatePostingError, isUniqueViolation } from "./errors.js";

describe("isUniqueViolation", () => {
  it("is true for a raw pg error with code 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("is true for a drizzle-wrapped error with the pg error on .cause", () => {
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
  });

  it("is false for a CHECK violation (23514), not a unique violation", () => {
    expect(isUniqueViolation({ code: "23514" })).toBe(false);
  });

  it("is false for an unrelated value", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it("respects the optional constraint filter", () => {
    const err = {
      code: "23505",
      constraint: "ledger_entries_operation_account_direction_uq",
    };
    expect(
      isUniqueViolation(err, "ledger_entries_operation_account_direction_uq"),
    ).toBe(true);
    expect(isUniqueViolation(err, "some_other_constraint")).toBe(false);
  });

  it("respects the constraint filter through the .cause unwrap", () => {
    const err = {
      cause: {
        code: "23505",
        constraint: "ledger_entries_operation_account_direction_uq",
      },
    };
    expect(
      isUniqueViolation(err, "ledger_entries_operation_account_direction_uq"),
    ).toBe(true);
    expect(isUniqueViolation(err, "some_other_constraint")).toBe(false);
  });
});

describe("DuplicatePostingError", () => {
  it("carries the operationId and an optional cause", () => {
    const cause = new Error("unique violation");
    const err = new DuplicatePostingError("op-1", { cause });
    expect(err.operationId).toBe("op-1");
    expect(err.cause).toBe(cause);
    expect(err.name).toBe("DuplicatePostingError");
    expect(err.message).toContain("op-1");
  });
});
