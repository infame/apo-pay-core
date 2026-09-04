import { describe, expect, it, beforeEach } from "vitest";
import { CreatePayment } from "./create-payment.js";
import { CapturePayment } from "./capture-payment.js";
import { CancelPayment } from "./cancel-payment.js";
import { type CancelParams } from "../ports/payment-provider.js";
import { MockProvider } from "../adapters/mock/mock-provider.js";
import { Payment } from "../domain/payment.js";
import { Money } from "../domain/money.js";
import { InMemoryPaymentRepository } from "../adapters/memory/in-memory-payment-repository.js";
import { InMemoryIdempotencyStore } from "../adapters/memory/in-memory-idempotency-store.js";
import { IdempotencyConflictError } from "../ports/idempotency-store.js";
import {
  IllegalStateTransitionError,
  PaymentNotFoundError,
} from "../domain/errors.js";

const CLOCK = () => new Date("2026-07-01T00:00:00Z");

/** Provider that records how many times a hold was voided. */
class CountingProvider extends MockProvider {
  cancelCalls: string[] = [];
  override async cancel(params: CancelParams): Promise<void> {
    this.cancelCalls.push(params.providerRef);
  }
}

describe("CancelPayment", () => {
  let repo: InMemoryPaymentRepository;
  let idempotency: InMemoryIdempotencyStore;
  let provider: CountingProvider;
  let create: CreatePayment;
  let capture: CapturePayment;
  let cancel: CancelPayment;

  beforeEach(() => {
    repo = new InMemoryPaymentRepository();
    idempotency = new InMemoryIdempotencyStore();
    provider = new CountingProvider();
    let seq = 0;
    create = new CreatePayment(
      repo,
      provider,
      idempotency,
      CLOCK,
      () => `pay_${++seq}`,
    );
    capture = new CapturePayment(repo, provider, idempotency, CLOCK);
    cancel = new CancelPayment(repo, provider, idempotency, CLOCK);
  });

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

  it("cancels an authorized payment and voids the hold at the provider", async () => {
    const id = await authorize(2000);
    const res = await cancel.execute({ paymentId: id, idempotencyKey: "cancel-1" });

    expect(res.status).toBe("canceled");
    expect(provider.cancelCalls).toHaveLength(1);
    expect(repo.outbox.map((e) => e.type)).toContain("payment.canceled");
  });

  it("is idempotent: a retry with the same key does not void twice", async () => {
    const id = await authorize(2000);
    const first = await cancel.execute({ paymentId: id, idempotencyKey: "cancel-1" });
    const second = await cancel.execute({ paymentId: id, idempotencyKey: "cancel-1" });

    expect(second).toEqual(first);
    expect(provider.cancelCalls).toHaveLength(1);
  });

  it("rejects cancelling a captured payment", async () => {
    const id = await authorize(2000);
    await capture.execute({ paymentId: id, idempotencyKey: "cap-1" });
    await expect(
      cancel.execute({ paymentId: id, idempotencyKey: "cancel-late" }),
    ).rejects.toBeInstanceOf(IllegalStateTransitionError);
  });

  it("rejects cancelling an unknown payment", async () => {
    await expect(
      cancel.execute({ paymentId: "missing", idempotencyKey: "cancel-missing" }),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  it("does not call the provider when cancelling a payment that never authorized", async () => {
    // Seed a bare `created` payment (no providerRef) straight through the domain
    // + repository — there is no hold, so cancel must skip the provider.
    const created = Payment.create({
      id: "pay_created",
      amount: Money.of(2000, "USD"),
      now: CLOCK(),
    });
    await repo.save(created, created.pullEvents());

    const res = await cancel.execute({
      paymentId: "pay_created",
      idempotencyKey: "cancel-created",
    });

    expect(res.status).toBe("canceled");
    expect(provider.cancelCalls).toHaveLength(0);
  });
});
