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

export const CapturePaymentCommand = z.object({
  paymentId: z.string().min(1),
  /** Omit to capture the full authorized amount. */
  amount: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1),
});
export type CapturePaymentCommand = z.infer<typeof CapturePaymentCommand>;

export interface CapturePaymentResult {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly currency: string;
  readonly capturedAmount: number;
  readonly refundedAmount: number;
}

/**
 * Capture funds on a previously authorized payment (full or partial).
 *
 * Ordering: the domain transition is validated first (must be `authorized`,
 * amount ≤ authorized), so the provider is never asked to move money for an
 * illegal transition. Only after the provider confirms do we persist. If the
 * provider call throws, nothing is saved and no idempotency record is written,
 * so the operation is safe to retry.
 *
 * Idempotency mirrors CreatePayment: a retry with the same key + same body
 * returns the original result without a second capture; the same key with a
 * different body is rejected with IdempotencyConflictError.
 */
export class CapturePayment {
  constructor(
    private readonly repo: PaymentRepository,
    private readonly provider: PaymentProvider,
    private readonly idempotency: IdempotencyStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(raw: CapturePaymentCommand): Promise<CapturePaymentResult> {
    const command = CapturePaymentCommand.parse(raw);
    const fingerprint = fingerprintOf(command);

    const existing = await this.idempotency.find(command.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new IdempotencyConflictError(command.idempotencyKey);
      }
      return existing.response as CapturePaymentResult;
    }

    const payment = await this.repo.findById(command.paymentId);
    if (!payment) {
      throw new PaymentNotFoundError(command.paymentId);
    }

    const amount =
      command.amount === undefined
        ? undefined
        : Money.of(command.amount, payment.amount.currency);

    payment.capture(amount, this.clock());

    await this.provider.capture({
      providerRef: providerRefOf(payment),
      amount: payment.capturedAmount,
    });

    await this.repo.save(payment, payment.pullEvents());

    const result: CapturePaymentResult = {
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
function fingerprintOf(command: CapturePaymentCommand): string {
  const canonical = JSON.stringify({
    paymentId: command.paymentId,
    amount: command.amount ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * A payment can only be captured from `authorized`, which guarantees a
 * providerRef was set at authorization time. This guard turns that invariant
 * into an explicit failure rather than passing `null` to the provider.
 */
function providerRefOf(payment: Payment): string {
  const ref = payment.providerRef;
  if (ref === null) {
    throw new Error(`Payment ${payment.id} has no providerRef to capture against`);
  }
  return ref;
}
