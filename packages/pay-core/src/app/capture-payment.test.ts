import { describe, expect, it, beforeEach } from "vitest";
import { CreatePayment } from "./create-payment.js";
import { CapturePayment } from "./capture-payment.js";
import { MockProvider } from "../adapters/mock/mock-provider.js";
import { InMemoryPaymentRepository } from "../adapters/memory/in-memory-payment-repository.js";
import { InMemoryIdempotencyStore } from "../adapters/memory/in-memory-idempotency-store.js";
import { IdempotencyConflictError } from "../ports/idempotency-store.js";
import {
  AmountExceededError,
  IllegalStateTransitionError,
  PaymentNotFoundError,
} from "../domain/errors.js";

const CLOCK = () => new Date("2026-07-01T00:00:00Z");

describe("CapturePayment", () => {
  let repo: InMemoryPaymentRepository;
  let idempotency: InMemoryIdempotencyStore;
  let create: CreatePayment;
  let capture: CapturePayment;

  beforeEach(() => {
    repo = new InMemoryPaymentRepository();
    idempotency = new InMemoryIdempotencyStore();
    const provider = new MockProvider();
    let seq = 0;
    create = new CreatePayment(
      repo,
      provider,
      idempotency,
      CLOCK,
      () => `pay_${++seq}`,
    );
    capture = new CapturePayment(repo, provider, idempotency, CLOCK);
  });

  /** Seed an authorized payment and return its id. */
  async function authorize(amount = 2000): Promise<string> {
    const res = await create.execute({
      amount,
      currency: "USD",
      paymentMethodToken: "tok_visa",
      idempotencyKey: `auth-${amount}`,
    });
    expect(res.status).toBe("authorized");
    return res.id;
  }

  it("captures the full authorized amount by default", async () => {
    const id = await authorize(2000);
    const res = await capture.execute({ paymentId: id, idempotencyKey: "cap-1" });

    expect(res.status).toBe("captured");
    expect(res.capturedAmount).toBe(2000);
    expect(res.refundedAmount).toBe(0);
    expect(repo.outbox.map((e) => e.type)).toContain("payment.captured");
  });

  it("supports partial capture", async () => {
    const id = await authorize(2000);
    const res = await capture.execute({
      paymentId: id,
      amount: 500,
      idempotencyKey: "cap-partial",
    });

    expect(res.status).toBe("captured");
    expect(res.capturedAmount).toBe(500);
  });

  it("is idempotent: a retry with the same key does not capture twice", async () => {
    const id = await authorize(2000);
    const first = await capture.execute({ paymentId: id, idempotencyKey: "cap-1" });
    const captureEventsBefore = repo.outbox.filter(
      (e) => e.type === "payment.captured",
    ).length;

    const second = await capture.execute({ paymentId: id, idempotencyKey: "cap-1" });

    expect(second).toEqual(first);
    const captureEventsAfter = repo.outbox.filter(
      (e) => e.type === "payment.captured",
    ).length;
    expect(captureEventsAfter).toBe(captureEventsBefore);
  });

  it("rejects a reused key with a different body", async () => {
    const id = await authorize(2000);
    await capture.execute({ paymentId: id, amount: 500, idempotencyKey: "cap-x" });
    await expect(
      capture.execute({ paymentId: id, amount: 700, idempotencyKey: "cap-x" }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("rejects capturing more than authorized", async () => {
    const id = await authorize(2000);
    await expect(
      capture.execute({ paymentId: id, amount: 3000, idempotencyKey: "cap-over" }),
    ).rejects.toBeInstanceOf(AmountExceededError);
  });

  it("rejects capturing a payment that is not authorized", async () => {
    const id = await authorize(2000);
    await capture.execute({ paymentId: id, idempotencyKey: "cap-1" });
    await expect(
      capture.execute({ paymentId: id, idempotencyKey: "cap-again" }),
    ).rejects.toBeInstanceOf(IllegalStateTransitionError);
  });

  it("rejects capturing an unknown payment", async () => {
    await expect(
      capture.execute({ paymentId: "missing", idempotencyKey: "cap-missing" }),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });
});
