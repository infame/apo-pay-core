import { createHash } from "node:crypto";
import { z } from "zod";
import { Money } from "../domain/money.js";
import type { Payment, PaymentStatus } from "../domain/payment.js";
import { PaymentNotFoundError } from "../domain/errors.js";
import type { PaymentRepository } from "../ports/payment-repository.js";
import type { PaymentProvider } from "../ports/payment-provider.js";
import {
  IdempotencyConflictError,
  type IdempotencyStore,
} from "../ports/idempotency-store.js";

export const RefundPaymentCommand = z.object({
  paymentId: z.string().min(1),
  amount: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
});
export type RefundPaymentCommand = z.infer<typeof RefundPaymentCommand>;

export interface RefundPaymentResult {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly currency: string;
  readonly capturedAmount: number;
  readonly refundedAmount: number;
}

/**
 * Refund part or all of a captured payment.
 *
 * Ordering mirrors CapturePayment: the domain transition is validated first
 * (must be `captured`/`partially_refunded`, cumulative refund ≤ captured), so
 * the provider is never asked to refund on an illegal transition. Persistence
 * happens only after the provider confirms; a provider failure leaves nothing
 * saved and no idempotency record, so the operation is safe to retry.
 *
 * Idempotency is what stops a double-clicked refund from returning money
 * twice: a retry with the same key + same body replays the stored result
 * without a second refund; a different body under the same key is a conflict.
 */
export class RefundPayment {
  constructor(
    private readonly repo: PaymentRepository,
    private readonly provider: PaymentProvider,
    private readonly idempotency: IdempotencyStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(raw: RefundPaymentCommand): Promise<RefundPaymentResult> {
    const command = RefundPaymentCommand.parse(raw);
    const fingerprint = fingerprintOf(command);

    const existing = await this.idempotency.find(command.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new IdempotencyConflictError(command.idempotencyKey);
      }
      return existing.response as RefundPaymentResult;
    }

    const payment = await this.repo.findById(command.paymentId);
    if (!payment) {
      throw new PaymentNotFoundError(command.paymentId);
    }

    const amount = Money.of(command.amount, payment.amount.currency);
    payment.refund(amount, this.clock());

    await this.provider.refund({
      providerRef: providerRefOf(payment),
      amount,
    });

    await this.repo.save(payment, payment.pullEvents());

    const result: RefundPaymentResult = {
      id: payment.id,
      status: payment.status,
      currency: payment.amount.currency,
      capturedAmount: payment.capturedAmount.amount,
      refundedAmount: payment.refundedAmount.amount,
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
function fingerprintOf(command: RefundPaymentCommand): string {
  const canonical = JSON.stringify({
    paymentId: command.paymentId,
    amount: command.amount,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * A payment can only be refunded from a captured state, which guarantees a
 * providerRef exists. This guard turns that invariant into an explicit failure
 * rather than passing `null` to the provider.
 */
function providerRefOf(payment: Payment): string {
  const ref = payment.providerRef;
  if (ref === null) {
    throw new Error(`Payment ${payment.id} has no providerRef to refund against`);
  }
  return ref;
}
