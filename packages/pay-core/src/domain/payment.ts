import { randomUUID } from "node:crypto";
import { Money } from "./money.js";
import { AmountExceededError, IllegalStateTransitionError } from "./errors.js";
import type { DomainEvent, DomainEventInput } from "./events.js";

/**
 * Payment lifecycle (auth/capture model):
 *
 *   created ──authorize──▶ authorized ──capture──▶ captured
 *      │                        │                     │
 *      │                        │                  refund
 *      ▼                        ▼                     ▼
 *   failed / canceled     failed / canceled   partially_refunded ──▶ refunded
 *
 * `captured` and `partially_refunded` both accept further refunds until the
 * full captured amount is returned, at which point the payment is `refunded`.
 */
export type PaymentStatus =
  | "created"
  | "authorized"
  | "captured"
  | "partially_refunded"
  | "refunded"
  | "failed"
  | "canceled";

export interface PaymentProps {
  readonly id: string;
  status: PaymentStatus;
  readonly amount: Money;
  capturedAmount: Money;
  refundedAmount: Money;
  providerRef: string | null;
  failureReason: string | null;
  readonly createdAt: Date;
  updatedAt: Date;
}

/** States from which no further transitions are allowed. */
const TERMINAL: ReadonlySet<PaymentStatus> = new Set([
  "refunded",
  "failed",
  "canceled",
]);

export class Payment {
  private readonly events: DomainEvent[] = [];

  private constructor(private readonly props: PaymentProps) {}

  // ── Construction ────────────────────────────────────────────────────────

  /** Create a brand-new payment in the `created` state. */
  static create(params: { id: string; amount: Money; now?: Date }): Payment {
    if (params.amount.isNegative() || params.amount.isZero()) {
      throw new AmountExceededError("Payment amount must be positive");
    }
    const now = params.now ?? new Date();
    const zero = Money.of(0, params.amount.currency);
    const payment = new Payment({
      id: params.id,
      status: "created",
      amount: params.amount,
      capturedAmount: zero,
      refundedAmount: zero,
      providerRef: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    });
    payment.record({
      type: "payment.created",
      paymentId: params.id,
      amount: params.amount.toJSON(),
      occurredAt: now,
    });
    return payment;
  }

  /** Rehydrate an existing payment from storage without emitting events. */
  static fromState(props: PaymentProps): Payment {
    return new Payment({ ...props });
  }

  // ── Transitions ─────────────────────────────────────────────────────────

  authorize(providerRef: string, now: Date = new Date()): void {
    this.assertNotTerminal("authorize");
    if (this.props.status !== "created") {
      throw new IllegalStateTransitionError(this.props.status, "authorize");
    }
    this.props.status = "authorized";
    this.props.providerRef = providerRef;
    this.touch(now);
    this.record({
      type: "payment.authorized",
      paymentId: this.props.id,
      providerRef,
      occurredAt: now,
    });
  }

  /**
   * Capture funds. Defaults to capturing the full authorized amount.
   * Partial capture is supported but the remainder is not re-capturable in
   * this model (single capture), mirroring most PSP defaults.
   */
  capture(amount?: Money, now: Date = new Date()): void {
    this.assertNotTerminal("capture");
    if (this.props.status !== "authorized") {
      throw new IllegalStateTransitionError(this.props.status, "capture");
    }
    const toCapture = amount ?? this.props.amount;
    if (toCapture.currency !== this.props.amount.currency) {
      throw new AmountExceededError(
        "Capture currency must match authorization",
      );
    }
    if (toCapture.isNegative() || toCapture.isZero()) {
      throw new AmountExceededError("Capture amount must be positive");
    }
    if (toCapture.greaterThan(this.props.amount)) {
      throw new AmountExceededError(
        `Capture ${toCapture} exceeds authorized ${this.props.amount}`,
      );
    }
    this.props.capturedAmount = toCapture;
    this.props.status = "captured";
    this.touch(now);
    this.record({
      type: "payment.captured",
      paymentId: this.props.id,
      amount: toCapture.toJSON(),
      occurredAt: now,
    });
  }

  /** Refund part or all of the captured amount. Idempotency is enforced one level up. */
  refund(amount: Money, now: Date = new Date()): void {
    if (
      this.props.status !== "captured" &&
      this.props.status !== "partially_refunded"
    ) {
      throw new IllegalStateTransitionError(this.props.status, "refund");
    }
    if (amount.currency !== this.props.amount.currency) {
      throw new AmountExceededError("Refund currency must match payment");
    }
    if (amount.isNegative() || amount.isZero()) {
      throw new AmountExceededError("Refund amount must be positive");
    }
    const newRefunded = this.props.refundedAmount.add(amount);
    if (newRefunded.greaterThan(this.props.capturedAmount)) {
      throw new AmountExceededError(
        `Refund would total ${newRefunded}, exceeding captured ${this.props.capturedAmount}`,
      );
    }
    this.props.refundedAmount = newRefunded;
    const fullyRefunded = newRefunded.equals(this.props.capturedAmount);
    this.props.status = fullyRefunded ? "refunded" : "partially_refunded";
    this.touch(now);
    this.record({
      type: "payment.refunded",
      paymentId: this.props.id,
      amount: amount.toJSON(),
      fullyRefunded,
      occurredAt: now,
    });
  }

  fail(reason: string, now: Date = new Date()): void {
    if (this.props.status !== "created" && this.props.status !== "authorized") {
      throw new IllegalStateTransitionError(this.props.status, "fail");
    }
    this.props.status = "failed";
    this.props.failureReason = reason;
    this.touch(now);
    this.record({
      type: "payment.failed",
      paymentId: this.props.id,
      reason,
      occurredAt: now,
    });
  }

  cancel(now: Date = new Date()): void {
    if (this.props.status !== "created" && this.props.status !== "authorized") {
      throw new IllegalStateTransitionError(this.props.status, "cancel");
    }
    this.props.status = "canceled";
    this.touch(now);
    this.record({
      type: "payment.canceled",
      paymentId: this.props.id,
      occurredAt: now,
    });
  }

  // ── Event handling ──────────────────────────────────────────────────────

  /** Drain recorded events. Callers persist these to the outbox transactionally. */
  pullEvents(): DomainEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /** Every event gets a stable id here, at creation time — see events.ts. */
  private record(event: DomainEventInput): void {
    this.events.push({ ...event, id: randomUUID() });
  }

  // ── Guards & accessors ──────────────────────────────────────────────────

  private assertNotTerminal(action: string): void {
    if (TERMINAL.has(this.props.status)) {
      throw new IllegalStateTransitionError(this.props.status, action);
    }
  }

  private touch(now: Date): void {
    this.props.updatedAt = now;
  }

  get id(): string {
    return this.props.id;
  }
  get status(): PaymentStatus {
    return this.props.status;
  }
  get amount(): Money {
    return this.props.amount;
  }
  get capturedAmount(): Money {
    return this.props.capturedAmount;
  }
  get refundedAmount(): Money {
    return this.props.refundedAmount;
  }
  get providerRef(): string | null {
    return this.props.providerRef;
  }

  /** Snapshot for persistence. */
  toState(): PaymentProps {
    return { ...this.props };
  }
}
