import { PaymentNotFoundError } from "../domain/errors.js";
import type { PaymentStatus } from "../domain/payment.js";
import type { PaymentRepository } from "../ports/payment-repository.js";

export interface GetPaymentResult {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly currency: string;
  readonly amountAuthorized: number;
  readonly capturedAmount: number;
  readonly refundedAmount: number;
  readonly providerRef: string | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Read a payment's current state. A pure query — no idempotency, no provider
 * call, no mutation.
 *
 * The transition history lives in the append-only `payment_events` table and
 * will be surfaced here once the Postgres adapter exists; the in-memory
 * repository only retains the current aggregate snapshot.
 */
export class GetPayment {
  constructor(private readonly repo: PaymentRepository) {}

  async execute(paymentId: string): Promise<GetPaymentResult> {
    const payment = await this.repo.findById(paymentId);
    if (!payment) {
      throw new PaymentNotFoundError(paymentId);
    }

    const state = payment.toState();
    return {
      id: state.id,
      status: state.status,
      currency: state.amount.currency,
      amountAuthorized: state.amount.amount,
      capturedAmount: state.capturedAmount.amount,
      refundedAmount: state.refundedAmount.amount,
      providerRef: state.providerRef,
      failureReason: state.failureReason,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }
}
