import { describe, expect, it, beforeEach } from "vitest";
import { CreatePayment } from "./create-payment.js";
import { CapturePayment } from "./capture-payment.js";
import { RefundPayment } from "./refund-payment.js";
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

describe("RefundPayment", () => {
  let repo: InMemoryPaymentRepository;
  let idempotency: InMemoryIdempotencyStore;
  let create: CreatePayment;
  let capture: CapturePayment;
  let refund: RefundPayment;

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
    refund = new RefundPayment(repo, provider, idempotency, CLOCK);
  });

  /** Seed a fully-captured payment and return its id. */
  async function captured(amount = 2000): Promise<string> {
    const auth = await create.execute({
      amount,
      currency: "USD",
      paymentMethodToken: "tok_visa",
      idempotencyKey: `auth-${amount}`,
    });
    await capture.execute({ paymentId: auth.id, idempotencyKey: `cap-${amount}` });
    return auth.id;
  }

  it("refunds the full captured amount", async () => {
    const id = await captured(2000);
    const res = await refund.execute({
      paymentId: id,
      amount: 2000,
      idempotencyKey: "ref-full",
    });

    expect(res.status).toBe("refunded");
    expect(res.refundedAmount).toBe(2000);
    expect(repo.outbox.map((e) => e.type)).toContain("payment.refunded");
  });

  it("supports partial refunds accumulating to a full refund", async () => {
    const id = await captured(2000);

    const first = await refund.execute({
      paymentId: id,
      amount: 500,
      idempotencyKey: "ref-1",
    });
    expect(first.status).toBe("partially_refunded");
    expect(first.refundedAmount).toBe(500);

    const second = await refund.execute({
      paymentId: id,
      amount: 1500,
      idempotencyKey: "ref-2",
    });
    expect(second.status).toBe("refunded");
    expect(second.refundedAmount).toBe(2000);
  });

  it("is idempotent: a retry with the same key does not refund twice", async () => {
    const id = await captured(2000);
    const first = await refund.execute({
      paymentId: id,
      amount: 500,
      idempotencyKey: "ref-1",
    });
    const refundEventsBefore = repo.outbox.filter(
      (e) => e.type === "payment.refunded",
    ).length;

    const second = await refund.execute({
      paymentId: id,
      amount: 500,
      idempotencyKey: "ref-1",
    });

    expect(second).toEqual(first);
    const refundEventsAfter = repo.outbox.filter(
      (e) => e.type === "payment.refunded",
    ).length;
    expect(refundEventsAfter).toBe(refundEventsBefore);
  });

  it("rejects a reused key with a different body", async () => {
    const id = await captured(2000);
    await refund.execute({ paymentId: id, amount: 500, idempotencyKey: "ref-x" });
    await expect(
      refund.execute({ paymentId: id, amount: 700, idempotencyKey: "ref-x" }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("rejects refunding more than captured", async () => {
    const id = await captured(2000);
    await expect(
      refund.execute({ paymentId: id, amount: 2500, idempotencyKey: "ref-over" }),
    ).rejects.toBeInstanceOf(AmountExceededError);
  });

  it("rejects refunding a payment that was never captured", async () => {
    const auth = await create.execute({
      amount: 2000,
      currency: "USD",
      paymentMethodToken: "tok_visa",
      idempotencyKey: "auth-only",
    });
    await expect(
      refund.execute({ paymentId: auth.id, amount: 100, idempotencyKey: "ref-none" }),
    ).rejects.toBeInstanceOf(IllegalStateTransitionError);
  });

  it("rejects refunding an unknown payment", async () => {
    await expect(
      refund.execute({ paymentId: "missing", amount: 100, idempotencyKey: "ref-missing" }),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });
});
