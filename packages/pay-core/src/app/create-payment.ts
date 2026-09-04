import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Money } from "../domain/money.js";
import { Payment, type PaymentStatus } from "../domain/payment.js";
import type { PaymentRepository } from "../ports/payment-repository.js";
import type { PaymentProvider } from "../ports/payment-provider.js";
import { ProviderDeclinedError } from "../ports/payment-provider.js";
import {
  IdempotencyConflictError,
  type IdempotencyStore,
} from "../ports/idempotency-store.js";

export const CreatePaymentCommand = z.object({
  amount: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  paymentMethodToken: z.string().min(1),
  idempotencyKey: z.string().min(1),
});
export type CreatePaymentCommand = z.infer<typeof CreatePaymentCommand>;

export interface CreatePaymentResult {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly amount: number;
  readonly currency: string;
  readonly providerRef: string | null;
}

/**
 * Create and authorize a payment.
 *
 * Idempotency: the operation is keyed on `idempotencyKey`. A retry with the
 * same key + same body returns the original result without touching the
 * provider again; a retry with the same key + a *different* body is rejected
 * with IdempotencyConflictError. This is what keeps double-clicks and network
 * retries from creating duplicate charges.
 */
export class CreatePayment {
  constructor(
    private readonly repo: PaymentRepository,
    private readonly provider: PaymentProvider,
    private readonly idempotency: IdempotencyStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = () => randomUUID(),
  ) {}

  async execute(raw: CreatePaymentCommand): Promise<CreatePaymentResult> {
    const command = CreatePaymentCommand.parse(raw);
    const fingerprint = fingerprintOf(command);

    const existing = await this.idempotency.find(command.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new IdempotencyConflictError(command.idempotencyKey);
      }
      return existing.response as CreatePaymentResult;
    }

    const now = this.clock();
    const money = Money.of(command.amount, command.currency);
    const payment = Payment.create({ id: this.newId(), amount: money, now });

    try {
      const { providerRef } = await this.provider.authorize({
        paymentId: payment.id,
        amount: money,
        paymentMethodToken: command.paymentMethodToken,
      });
      payment.authorize(providerRef, this.clock());
    } catch (err) {
      if (err instanceof ProviderDeclinedError) {
        payment.fail(err.reason, this.clock());
      } else {
        throw err;
      }
    }

    await this.repo.save(payment, payment.pullEvents());

    const result: CreatePaymentResult = {
      id: payment.id,
      status: payment.status,
      amount: money.amount,
      currency: money.currency,
      providerRef: payment.providerRef,
    };

    await this.idempotency.save({
      key: command.idempotencyKey,
      requestFingerprint: fingerprint,
      response: result,
      createdAt: this.clock(),
    });

    return result;
  }
}

/** Stable hash over the semantically relevant request fields (excludes the key). */
function fingerprintOf(command: CreatePaymentCommand): string {
  const canonical = JSON.stringify({
    amount: command.amount,
    currency: command.currency,
    paymentMethodToken: command.paymentMethodToken,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
