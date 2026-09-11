/**
 * Outbound port for talking to `@apo/pay-core` over its HTTP API — never as
 * an imported library (see ADR-0005 and this package's README, "Why a
 * duplicated `Money`" section: the same "no compile-time coupling" reasoning
 * applies to every type in this file). All request/response shapes below are
 * defined independently of `packages/pay-core/src/app/*.ts`'s own command
 * and result types; they happen to line up field-for-field today because
 * they describe the same wire contract, but nothing here imports from
 * `@apo/pay-core`.
 */

export type PaymentStatus =
  | "created"
  | "authorized"
  | "captured"
  | "partially_refunded"
  | "refunded"
  | "failed"
  | "canceled";

export type PayCoreOperation =
  | "create_payment"
  | "capture_payment"
  | "refund_payment"
  | "cancel_payment"
  | "get_payment";

export interface RequestOptions {
  /** Overrides `HttpPayCoreClientOptions.timeoutMs`/`DEFAULT_REQUEST_TIMEOUT_MS` for this call only. */
  readonly timeoutMs?: number;
  /** Caller-supplied cancellation, distinct from the request timeout — see `PayCoreRequestCanceledError` vs `PayCoreTimeoutError`. */
  readonly signal?: AbortSignal;
}

export interface IdempotentRequestOptions extends RequestOptions {
  /** Sent verbatim as the `Idempotency-Key` header. Required non-blank on every mutating route. */
  readonly idempotencyKey: string;
}

export interface CreatePaymentRequest {
  readonly amount: number;
  readonly currency: string;
  readonly paymentMethodToken: string;
}

export interface CreatePaymentResponse {
  readonly id: string;
  /**
   * NOTE: an authorize decline is NOT an HTTP error. pay-core's
   * `CreatePayment` use-case catches `ProviderDeclinedError` internally and
   * persists a failed payment, returning `201` with `status: "failed"` in
   * the body. `createPayment` below resolves normally in that case — do not
   * add a throw for it, and do not "fix" this later without re-reading
   * `packages/pay-core/src/app/create-payment.ts`.
   */
  readonly status: PaymentStatus;
  readonly amount: number;
  readonly currency: string;
  readonly providerRef: string | null;
}

export interface CapturePaymentRequest {
  readonly paymentId: string;
  /** Omit to capture the full authorized amount. */
  readonly amount?: number;
}

export interface CapturePaymentResponse {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly currency: string;
  readonly capturedAmount: number;
  readonly refundedAmount: number;
}

export interface RefundPaymentRequest {
  readonly paymentId: string;
  readonly amount: number;
}

export interface RefundPaymentResponse {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly currency: string;
  readonly capturedAmount: number;
  readonly refundedAmount: number;
}

export interface CancelPaymentRequest {
  readonly paymentId: string;
}

export interface CancelPaymentResponse {
  readonly id: string;
  readonly status: PaymentStatus;
}

export interface PaymentSnapshot {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly currency: string;
  readonly amountAuthorized: number;
  readonly capturedAmount: number;
  readonly refundedAmount: number;
  readonly providerRef: string | null;
  readonly failureReason: string | null;
  /** ISO-8601 strings, not `Date`s — pay-core's Hono layer serializes `Date` fields to JSON as strings. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PayCoreClient {
  /** `POST /payments`. Resolves normally even when `status === "failed"` — see `CreatePaymentResponse.status`. */
  createPayment(
    req: CreatePaymentRequest,
    opts: IdempotentRequestOptions,
  ): Promise<CreatePaymentResponse>;

  /** `POST /payments/:id/capture`. */
  capturePayment(
    req: CapturePaymentRequest,
    opts: IdempotentRequestOptions,
  ): Promise<CapturePaymentResponse>;

  /** `POST /payments/:id/refund`. */
  refundPayment(
    req: RefundPaymentRequest,
    opts: IdempotentRequestOptions,
  ): Promise<RefundPaymentResponse>;

  /** `POST /payments/:id/cancel`. */
  cancelPayment(
    req: CancelPaymentRequest,
    opts: IdempotentRequestOptions,
  ): Promise<CancelPaymentResponse>;

  /** `GET /payments/:id`. Not idempotency-keyed — it's a pure read. */
  getPayment(
    paymentId: string,
    opts?: RequestOptions,
  ): Promise<PaymentSnapshot>;
}
