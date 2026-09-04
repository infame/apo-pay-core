import { describe, expect, it, beforeEach } from "vitest";
import { CreatePayment } from "./create-payment.js";
import { CapturePayment } from "./capture-payment.js";
import { GetPayment } from "./get-payment.js";
import { MockProvider } from "../adapters/mock/mock-provider.js";
import { InMemoryPaymentRepository } from "../adapters/memory/in-memory-payment-repository.js";
import { InMemoryIdempotencyStore } from "../adapters/memory/in-memory-idempotency-store.js";
import { PaymentNotFoundError } from "../domain/errors.js";

const CLOCK = () => new Date("2026-07-01T00:00:00Z");

describe("GetPayment", () => {
  let repo: InMemoryPaymentRepository;
  let idempotency: InMemoryIdempotencyStore;
  let create: CreatePayment;
  let capture: CapturePayment;
  let get: GetPayment;

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
    get = new GetPayment(repo);
  });

  it("returns the current state snapshot", async () => {
    const created = await create.execute({
      amount: 2000,
      currency: "USD",
      paymentMethodToken: "tok_visa",
      idempotencyKey: "auth-1",
    });
    await capture.execute({
      paymentId: created.id,
      amount: 500,
      idempotencyKey: "cap-1",
    });

    const view = await get.execute(created.id);

    expect(view).toMatchObject({
      id: created.id,
      status: "captured",
      currency: "USD",
      amountAuthorized: 2000,
      capturedAmount: 500,
      refundedAmount: 0,
      failureReason: null,
    });
    expect(view.providerRef).toMatch(/^mock_/);
    expect(view.createdAt).toEqual(CLOCK());
  });

  it("throws for an unknown payment", async () => {
    await expect(get.execute("missing")).rejects.toBeInstanceOf(
      PaymentNotFoundError,
    );
  });
});
