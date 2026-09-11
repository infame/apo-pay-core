import { describe, expect, it } from "vitest";
import { stepOperationId } from "./operation-id.js";
import { stepIdempotencyKey } from "./idempotency-key.js";

const V8_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("stepOperationId", () => {
  it("is deterministic for the same (runId, stepName)", () => {
    const a = stepOperationId("run-1", "authorize");
    const b = stepOperationId("run-1", "authorize");
    expect(a).toBe(b);
  });

  it("differs for different stepNames under the same runId", () => {
    const authorize = stepOperationId("run-1", "authorize");
    const capture = stepOperationId("run-1", "capture");
    expect(authorize).not.toBe(capture);
  });

  it("differs for different runIds under the same stepName", () => {
    const a = stepOperationId("run-1", "authorize");
    const b = stepOperationId("run-2", "authorize");
    expect(a).not.toBe(b);
  });

  it("produces a v8, RFC-4122-variant UUID", () => {
    const id = stepOperationId("run-1", "post-ledger");
    expect(id).toMatch(V8_UUID);
  });

  it("throws on a blank runId", () => {
    expect(() => stepOperationId("", "authorize")).toThrow();
    expect(() => stepOperationId("   ", "authorize")).toThrow();
  });

  it("throws on a blank stepName", () => {
    expect(() => stepOperationId("run-1", "")).toThrow();
    expect(() => stepOperationId("run-1", "   ")).toThrow();
  });

  it("is genuinely a different derivation from stepIdempotencyKey, not the same value reused", () => {
    const runId = "run-1";
    const stepName = "authorize";
    expect(stepOperationId(runId, stepName)).not.toBe(
      stepIdempotencyKey(runId, stepName),
    );
  });
});
