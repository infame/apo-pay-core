/**
 * Domain errors are typed, not stringly-typed. Callers (use-cases, HTTP layer)
 * can branch on the class and map to transport-specific codes without parsing
 * message strings.
 */

import type { PaymentStatus } from "./payment.js";

export abstract class DomainError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An operation was attempted that the payment's current state forbids. */
export class IllegalStateTransitionError extends DomainError {
  readonly code = "illegal_state_transition";
  constructor(
    readonly from: PaymentStatus,
    readonly attempted: string,
  ) {
    super(`Cannot ${attempted} a payment in state "${from}"`);
  }
}

/** A refund/capture amount exceeded what the payment allows. */
export class AmountExceededError extends DomainError {
  readonly code = "amount_exceeded";
  constructor(message: string) {
    super(message);
  }
}

/** No payment exists for the given id. */
export class PaymentNotFoundError extends DomainError {
  readonly code = "payment_not_found";
  constructor(readonly id: string) {
    super(`Payment "${id}" not found`);
  }
}
