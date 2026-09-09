import { describe, expect, it, beforeEach } from "vitest";
import { CreatePayment } from "./create-payment.js";
import { MockProvider } from "../adapters/mock/mock-provider.js";
import { SimulatorProvider } from "../adapters/simulator/simulator-provider.js";
import { InMemoryPaymentRepository } from "../adapters/memory/in-memory-payment-repository.js";
import { InMemoryIdempotencyStore } from "../adapters/memory/in-memory-idempotency-store.js";
import { IdempotencyConflictError } from "../ports/idempotency-store.js";
import { ProviderUnavailableError } from "../ports/payment-provider.js";

describe("CreatePayment", () => {
  let repo: InMemoryPaymentRepository;
  let idempotency: InMemoryIdempotencyStore;
  let useCase: CreatePayment;

  beforeEach(() => {
    repo = new InMemoryPaymentRepository();
    idempotency = new InMemoryIdempotencyStore();
    let seq = 0;
    useCase = new CreatePayment(
      repo,
      new MockProvider(),
      idempotency,
      () => new Date("2026-07-01T00:00:00Z"),
      () => `pay_${++seq}`,
    );
  });

  const command = {
    amount: 2000,
    currency: "USD",
    paymentMethodToken: "tok_visa",
    idempotencyKey: "key-1",
  };

  it("authorizes a payment on the happy path", async () => {
    const res = await useCase.execute(command);
    expect(res.status).toBe("authorized");
    expect(res.providerRef).toMatch(/^mock_/);
    expect(repo.outbox.map((e) => e.type)).toEqual([
      "payment.created",
      "payment.authorized",
    ]);
  });

  it("is idempotent: a retry with the same key does not create a second charge", async () => {
    const first = await useCase.execute(command);
    const second = await useCase.execute(command);

    expect(second).toEqual(first);
    // Provider was only hit once → only one create+authorize pair in the outbox.
    expect(repo.outbox).toHaveLength(2);
  });

  it("rejects a reused key with a different body", async () => {
    await useCase.execute(command);
    await expect(
      useCase.execute({ ...command, amount: 9999 }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("records a failed payment when the provider declines", async () => {
    // Mock declines amounts whose minor units end in 13.
    const res = await useCase.execute({
      ...command,
      amount: 1013,
      idempotencyKey: "key-decline",
    });
    expect(res.status).toBe("failed");
    expect(res.providerRef).toBeNull();
    expect(repo.outbox.map((e) => e.type)).toContain("payment.failed");
  });

  it("a transient provider failure persists nothing and a same-command retry then succeeds", async () => {
    let seq = 0;
    const simulator = new SimulatorProvider();
    const flaky = new CreatePayment(
      repo,
      simulator,
      idempotency,
      () => new Date("2026-07-01T00:00:00Z"),
      () => `pay_${++seq}`,
    );
    const flakyCommand = {
      ...command,
      paymentMethodToken: "sim.fail_then_succeed",
      idempotencyKey: "key-flaky",
    };

    await expect(flaky.execute(flakyCommand)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(repo.outbox).toHaveLength(0);
    expect(await idempotency.find(flakyCommand.idempotencyKey)).toBeNull();

    const res = await flaky.execute(flakyCommand);
    expect(res.status).toBe("authorized");
  });
});
