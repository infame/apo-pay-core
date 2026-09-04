import { Payment } from "../../domain/payment.js";
import type { DomainEvent } from "../../domain/events.js";
import type { PaymentRepository } from "../../ports/payment-repository.js";

/**
 * In-memory repository for tests and local demos. Mirrors the transactional
 * contract of the real (Drizzle/Postgres) implementation: state and events are
 * committed together. Here "the transaction" is just a synchronous mutation, so
 * it can't partially fail — but the shape matches, and the outbox is populated
 * exactly as the real dispatcher expects.
 */
export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly payments = new Map<string, ReturnType<Payment["toState"]>>();
  /** Publicly readable so tests/demo can inspect what would be dispatched. */
  readonly outbox: DomainEvent[] = [];

  async findById(id: string): Promise<Payment | null> {
    const state = this.payments.get(id);
    return state ? Payment.fromState({ ...state }) : null;
  }

  async save(payment: Payment, events: DomainEvent[]): Promise<void> {
    this.payments.set(payment.id, payment.toState());
    this.outbox.push(...events);
  }
}
