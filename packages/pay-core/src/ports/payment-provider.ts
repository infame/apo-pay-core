import type { Money } from "../domain/money.js";

/**
 * A PaymentProvider is the outbound port to an external PSP (Stripe, Adyen, …).
 * The domain and use-cases depend on this interface only — never on a vendor
 * SDK. Adapters live under src/adapters/<provider>/.
 */
export interface PaymentProvider {
  readonly name: string;

  /** Authorize funds with the provider, returning its reference id. */
  authorize(params: AuthorizeParams): Promise<AuthorizeResult>;

  /** Capture previously authorized funds. */
  capture(params: CaptureParams): Promise<void>;

  /** Refund captured funds (partial or full). */
  refund(params: RefundParams): Promise<void>;

  /** Void a previously authorized hold that was never captured. */
  cancel(params: CancelParams): Promise<void>;
}

export interface AuthorizeParams {
  readonly paymentId: string;
  readonly amount: Money;
  /** Opaque token from the client (e.g. Stripe PaymentMethod id). */
  readonly paymentMethodToken: string;
}

export interface AuthorizeResult {
  readonly providerRef: string;
}

export interface CaptureParams {
  readonly providerRef: string;
  readonly amount: Money;
}

export interface RefundParams {
  readonly providerRef: string;
  readonly amount: Money;
}

export interface CancelParams {
  readonly providerRef: string;
}

/** Provider declined the operation (insufficient funds, fraud, etc.). */
export class ProviderDeclinedError extends Error {
  constructor(
    readonly reason: string,
    readonly declineCode?: string,
  ) {
    super(`Provider declined: ${reason}`);
    this.name = "ProviderDeclinedError";
  }
}
