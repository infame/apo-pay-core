import { describe, expect, it } from "vitest";
import { Money } from "./money.js";
import { Payment } from "./payment.js";
import { AmountExceededError, IllegalStateTransitionError } from "./errors.js";

const usd = (n: number) => Money.of(n, "USD");
const newPayment = (amount = 1000) =>
  Payment.create({ id: "pay_1", amount: usd(amount) });

describe("Payment state machine", () => {
  it("emits a created event on construction", () => {
    const events = newPayment().pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("payment.created");
  });

  it("gives every event a stable, unique id at creation time", () => {
    const p = newPayment();
    p.authorize("ref");
    p.capture();
    const events = p.pullEvents();
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(typeof event.id).toBe("string");
      expect(event.id.length).toBeGreaterThan(0);
    }
    const ids = new Set(events.map((e) => e.id));
    expect(ids.size).toBe(events.length);
  });

  it("rejects a zero or negative amount", () => {
    expect(() => Payment.create({ id: "x", amount: usd(0) })).toThrow(
      AmountExceededError,
    );
  });

  it("walks the happy path created → authorized → captured", () => {
    const p = newPayment();
    p.pullEvents();
    p.authorize("mock_ref");
    expect(p.status).toBe("authorized");
    expect(p.providerRef).toBe("mock_ref");
    p.capture();
    expect(p.status).toBe("captured");
    expect(p.capturedAmount.equals(usd(1000))).toBe(true);
    expect(p.pullEvents().map((e) => e.type)).toEqual([
      "payment.authorized",
      "payment.captured",
    ]);
  });

  it("forbids capturing before authorization", () => {
    const p = newPayment();
    expect(() => p.capture()).toThrow(IllegalStateTransitionError);
  });

  it("forbids capturing more than authorized", () => {
    const p = newPayment(1000);
    p.authorize("ref");
    expect(() => p.capture(usd(1001))).toThrow(AmountExceededError);
  });

  it("supports partial then full refund", () => {
    const p = newPayment(1000);
    p.authorize("ref");
    p.capture();
    p.pullEvents();

    p.refund(usd(400));
    expect(p.status).toBe("partially_refunded");
    expect(p.refundedAmount.equals(usd(400))).toBe(true);

    p.refund(usd(600));
    expect(p.status).toBe("refunded");
    const last = p.pullEvents().at(-1);
    expect(last?.type).toBe("payment.refunded");
    expect(last?.type === "payment.refunded" && last.fullyRefunded).toBe(true);
  });

  it("forbids refunding more than captured", () => {
    const p = newPayment(1000);
    p.authorize("ref");
    p.capture();
    expect(() => p.refund(usd(1001))).toThrow(AmountExceededError);
  });

  it("forbids any transition from a terminal state", () => {
    const p = newPayment();
    p.fail("insufficient_funds");
    expect(p.status).toBe("failed");
    expect(() => p.authorize("ref")).toThrow(IllegalStateTransitionError);
    expect(() => p.cancel()).toThrow(IllegalStateTransitionError);
  });
});
