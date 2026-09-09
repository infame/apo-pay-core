import type { Money } from "./money.js";

/**
 * Domain events emitted by the Payment aggregate. These are the source of
 * truth for what the system should react to (notifications, ledger updates,
 * webhooks to merchants). They are recorded on the aggregate and later
 * persisted to the outbox in the same DB transaction as the state change.
 */

interface BaseEvent {
  /**
   * Stable event id, minted by the aggregate when the event is recorded (see
   * `Payment.record`), not by the persistence adapter. This is what lets
   * downstream consumers (Inngest steps in `durable-ledger`) dedupe deliveries
   * — see ADR-0003.
   */
  readonly id: string;
  readonly paymentId: string;
  readonly occurredAt: Date;
}

export interface PaymentCreated extends BaseEvent {
  readonly type: "payment.created";
  readonly amount: ReturnType<Money["toJSON"]>;
}

export interface PaymentAuthorized extends BaseEvent {
  readonly type: "payment.authorized";
  readonly providerRef: string;
}

export interface PaymentCaptured extends BaseEvent {
  readonly type: "payment.captured";
  readonly amount: ReturnType<Money["toJSON"]>;
}

export interface PaymentRefunded extends BaseEvent {
  readonly type: "payment.refunded";
  readonly amount: ReturnType<Money["toJSON"]>;
  readonly fullyRefunded: boolean;
}

export interface PaymentFailed extends BaseEvent {
  readonly type: "payment.failed";
  readonly reason: string;
}

export interface PaymentCanceled extends BaseEvent {
  readonly type: "payment.canceled";
}

export type DomainEvent =
  | PaymentCreated
  | PaymentAuthorized
  | PaymentCaptured
  | PaymentRefunded
  | PaymentFailed
  | PaymentCanceled;

/**
 * `DomainEvent` minus `id`, for constructing an event before the aggregate
 * mints its id (`Payment.record`). A plain `Omit<DomainEvent, "id">` would
 * collapse the union to only its shared members (`Omit` isn't distributive);
 * this conditional type is, so each variant keeps its own fields
 * (`amount`, `providerRef`, `reason`, …).
 */
type DistributeOmitId<T> = T extends unknown ? Omit<T, "id"> : never;
export type DomainEventInput = DistributeOmitId<DomainEvent>;
