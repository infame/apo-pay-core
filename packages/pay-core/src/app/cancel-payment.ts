import { createHash } from "node:crypto";
import { z } from "zod";
import type { PaymentStatus } from "../domain/payment.js";
import { PaymentNotFoundError } from "../domain/errors.js";
import type { PaymentRepository } from "../ports/payment-repository.js";
import type { PaymentProvider } from "../ports/payment-provider.js";
import {
  IdempotencyConflictError,
  type IdempotencyStore,
} from "../ports/idempotency-store.js";

export const CancelPaymentCommand = z.object({
  paymentId: z.string().min(1),
  idempotencyKey: z.string().min(1),
});
export type CancelPaymentCommand = z.infer<typeof CancelPaymentCommand>;

export interface CancelPaymentResult {
  readonly id: string;
  readonly status: PaymentStatus;
}

/**
 * Cancel a payment before capture: release the authorization hold, or abandon a
 * payment that was only created. The domain transition (`created`/`authorized`
 * → `canceled`) is validated first, so the provider is never asked to void an
 * illegal state.
 *
 * The provider is only called when a hold actually exists — a `created` payment
 * that never authorized has no `providerRef` and nothing to void. As with the
 * other mutations, persistence happens only after the provider confirms, so a
 * provider failure leaves nothing saved and the operation is safe to retry.
 */
export class CancelPayment {
  constructor(
    private readonly repo: PaymentRepository,
    private readonly provider: PaymentProvider,
    private readonly idempotency: IdempotencyStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(raw: CancelPaymentCommand): Promise<CancelPaymentResult> {
    const command = CancelPaymentCommand.parse(raw);
    const fingerprint = fingerprintOf(command);

    const existing = await this.idempotency.find(command.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new IdempotencyConflictError(command.idempotencyKey);
      }
      return existing.response as CancelPaymentResult;
    }

    const payment = await this.repo.findById(command.paymentId);
    if (!payment) {
      throw new PaymentNotFoundError(command.paymentId);
    }

    const providerRef = payment.providerRef;
    payment.cancel(this.clock());

    if (providerRef !== null) {
      await this.provider.cancel({ providerRef });
    }

    await this.repo.save(payment, payment.pullEvents());

    const result: CancelPaymentResult = {
      id: payment.id,
      status: payment.status,
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
function fingerprintOf(command: CancelPaymentCommand): string {
  const canonical = JSON.stringify({ paymentId: command.paymentId });
  return createHash("sha256").update(canonical).digest("hex");
}
