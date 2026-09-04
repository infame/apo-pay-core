import { Money } from "../../../domain/money.js";
import {
  Payment,
  type PaymentProps,
  type PaymentStatus,
} from "../../../domain/payment.js";
import type { DomainEvent } from "../../../domain/events.js";
import type {
  NewPaymentEventRow,
  NewPaymentRow,
  PaymentRow,
} from "./schema.js";

/** `payments` row → `Payment` aggregate, via the existing `fromState` seam. */
export function rowToPayment(row: PaymentRow): Payment {
  const currency = row.currency;
  const props: PaymentProps = {
    id: row.id,
    status: row.status as PaymentStatus,
    amount: Money.of(row.amountAuthorized, currency),
    capturedAmount: Money.of(row.amountCaptured, currency),
    refundedAmount: Money.of(row.amountRefunded, currency),
    providerRef: row.providerRef,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return Payment.fromState(props);
}

/** `Payment` aggregate → `payments` insert/update row, via `toState`. */
export function paymentToRow(payment: Payment, version: number): NewPaymentRow {
  const state = payment.toState();
  return {
    id: state.id,
    status: state.status,
    currency: state.amount.currency,
    amountAuthorized: state.amount.amount,
    amountCaptured: state.capturedAmount.amount,
    amountRefunded: state.refundedAmount.amount,
    providerRef: state.providerRef,
    failureReason: state.failureReason,
    version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

/**
 * `DomainEvent` → `payment_events` payload (jsonb). An exhaustive switch on
 * `event.type` with a `never` default: a 7th event variant that isn't handled
 * here fails compilation instead of silently dropping fields at persistence
 * time.
 */
export function eventToPayload(event: DomainEvent): Record<string, unknown> {
  switch (event.type) {
    case "payment.created":
      return { amount: event.amount };
    case "payment.authorized":
      return { providerRef: event.providerRef };
    case "payment.captured":
      return { amount: event.amount };
    case "payment.refunded":
      return { amount: event.amount, fullyRefunded: event.fullyRefunded };
    case "payment.failed":
      return { reason: event.reason };
    case "payment.canceled":
      return {};
    default: {
      const _exhaustive: never = event;
      throw new Error(
        `Unhandled domain event type: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/** `DomainEvent` → `payment_events` insert row. */
export function eventToRow(event: DomainEvent): NewPaymentEventRow {
  return {
    id: event.id,
    paymentId: event.paymentId,
    type: event.type,
    payload: eventToPayload(event),
    occurredAt: event.occurredAt,
  };
}
