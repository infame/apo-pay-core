import type { Payment } from "../domain/payment.js";
import type { DomainEvent } from "../domain/events.js";

/**
 * Persistence port for the Payment aggregate.
 *
 * `save` must persist the aggregate state AND the given domain events to the
 * outbox in a single atomic transaction. This is what makes event delivery
 * reliable: either both the state change and the outbox row commit, or neither
 * does. A separate dispatcher later relays outbox rows to subscribers.
 */
export interface PaymentRepository {
  findById(id: string): Promise<Payment | null>;

  /** Atomically persist aggregate state + outbox events. */
  save(payment: Payment, events: DomainEvent[]): Promise<void>;
}
