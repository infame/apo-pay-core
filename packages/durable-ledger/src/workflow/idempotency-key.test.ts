import { describe, expect, it } from "vitest";
import { stepIdempotencyKey } from "./idempotency-key.js";

describe("stepIdempotencyKey", () => {
  it("is deterministic: the same inputs produce the same key", () => {
    const a = stepIdempotencyKey("run-1", "capture");
    const b = stepIdempotencyKey("run-1", "capture");
    expect(a).toBe(b);
  });

  it("differs when runId differs", () => {
    const a = stepIdempotencyKey("run-1", "capture");
    const b = stepIdempotencyKey("run-2", "capture");
    expect(a).not.toBe(b);
  });

  it("differs when stepName differs", () => {
    const a = stepIdempotencyKey("run-1", "capture");
    const b = stepIdempotencyKey("run-1", "refund");
    expect(a).not.toBe(b);
  });

  it("is 64 lowercase hex characters (sha256 hex digest)", () => {
    const key = stepIdempotencyKey("run-1", "capture");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws on an empty runId", () => {
    expect(() => stepIdempotencyKey("", "capture")).toThrow();
  });

  it("throws on a whitespace-only runId", () => {
    expect(() => stepIdempotencyKey("   ", "capture")).toThrow();
  });

  it("throws on an empty stepName", () => {
    expect(() => stepIdempotencyKey("run-1", "")).toThrow();
  });

  it("throws on a whitespace-only stepName", () => {
    expect(() => stepIdempotencyKey("run-1", "   ")).toThrow();
  });

  it('has the documented accepted collision: ("a:b","c") === ("a","b:c")', () => {
    // Both concatenate to the same "a:b:c" string under the "runId:stepName"
    // formula — a known, accepted trade-off (see the header comment on
    // stepIdempotencyKey), pinned here rather than left only as a comment.
    const a = stepIdempotencyKey("a:b", "c");
    const b = stepIdempotencyKey("a", "b:c");
    expect(a).toBe(b);
  });
});
