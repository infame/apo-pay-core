import { randomUUID } from "node:crypto";
import type {
  CancelPaymentRequest,
  CancelPaymentResponse,
  CapturePaymentRequest,
  CapturePaymentResponse,
  CreatePaymentRequest,
  CreatePaymentResponse,
  IdempotentRequestOptions,
  PayCoreClient,
  PaymentSnapshot,
  PayCoreOperation,
  RefundPaymentRequest,
  RefundPaymentResponse,
  RequestOptions,
} from "../ports/pay-core-client.js";

/**
 * Test support only — deliberately NOT exported from `src/index.ts` (matches
 * `../adapters/http/fake-pay-core-server.ts`'s precedent, ADR-0006). A
 * directive-driven `PayCoreClient` test double for `payment-execute.test.ts`:
 * each call pops the next scripted directive for that method off a queue (a
 * value to resolve with, or an error to throw) and records what was called,
 * with what request and `Idempotency-Key`, in `calls` — so a test can assert
 * exactly what was called, in what order, and with which key, without
 * spinning up `fake-pay-core-server.ts`'s real `node:http` server (this
 * double never touches the network; `payment-execute.test.ts` only needs the
 * `PayCoreClient` port's shape, not the wire contract `fake-pay-core-server.ts`
 * pins).
 */

export type FakeCreatePaymentDirective =
  | { readonly kind: "resolve"; readonly response: CreatePaymentResponse }
  | { readonly kind: "reject"; readonly error: Error };

export type FakeCapturePaymentDirective =
  | { readonly kind: "resolve"; readonly response: CapturePaymentResponse }
  | { readonly kind: "reject"; readonly error: Error };

export type FakeRefundPaymentDirective =
  | { readonly kind: "resolve"; readonly response: RefundPaymentResponse }
  | { readonly kind: "reject"; readonly error: Error };

export type FakeCancelPaymentDirective =
  | { readonly kind: "resolve"; readonly response: CancelPaymentResponse }
  | { readonly kind: "reject"; readonly error: Error };

export type FakeGetPaymentDirective =
  | { readonly kind: "resolve"; readonly response: PaymentSnapshot }
  | { readonly kind: "reject"; readonly error: Error };

export interface FakeCallRecord {
  readonly method: PayCoreOperation;
  readonly request: unknown;
  /** `undefined` for `getPayment`, which isn't idempotency-keyed. */
  readonly idempotencyKey: string | undefined;
}

/** A ready-made `CreatePaymentResponse` for the happy path — `status: "authorized"`. */
export function authorizedPaymentResponse(
  overrides?: Partial<CreatePaymentResponse>,
): CreatePaymentResponse {
  return {
    id: randomUUID(),
    status: "authorized",
    amount: 1000,
    currency: "USD",
    providerRef: `sim_${randomUUID()}`,
    ...overrides,
  };
}

/** A ready-made `CreatePaymentResponse` for the 201-with-status:"failed" decline case. */
export function declinedAtAuthorizeResponse(
  overrides?: Partial<CreatePaymentResponse>,
): CreatePaymentResponse {
  return {
    id: randomUUID(),
    status: "failed",
    amount: 1000,
    currency: "USD",
    providerRef: null,
    ...overrides,
  };
}

/** A ready-made `CapturePaymentResponse` for the happy path. */
export function capturedPaymentResponse(
  paymentId: string,
  overrides?: Partial<CapturePaymentResponse>,
): CapturePaymentResponse {
  return {
    id: paymentId,
    status: "captured",
    currency: "USD",
    capturedAmount: 1000,
    refundedAmount: 0,
    ...overrides,
  };
}

/**
 * A scripted, in-process `PayCoreClient` double. Each method call: (1)
 * records a `FakeCallRecord`, (2) pops the next queued directive for that
 * method (FIFO), and (3) resolves or rejects accordingly. Calling a method
 * with no queued directive throws — a test forgetting to script a call is a
 * bug in the test, not a case to silently paper over with a default.
 */
export class FakePayCoreClient implements PayCoreClient {
  readonly calls: FakeCallRecord[] = [];

  readonly #createPayment: FakeCreatePaymentDirective[] = [];
  readonly #capturePayment: FakeCapturePaymentDirective[] = [];
  readonly #refundPayment: FakeRefundPaymentDirective[] = [];
  readonly #cancelPayment: FakeCancelPaymentDirective[] = [];
  readonly #getPayment: FakeGetPaymentDirective[] = [];

  scriptCreatePayment(directive: FakeCreatePaymentDirective): this {
    this.#createPayment.push(directive);
    return this;
  }

  scriptCapturePayment(directive: FakeCapturePaymentDirective): this {
    this.#capturePayment.push(directive);
    return this;
  }

  scriptRefundPayment(directive: FakeRefundPaymentDirective): this {
    this.#refundPayment.push(directive);
    return this;
  }

  scriptCancelPayment(directive: FakeCancelPaymentDirective): this {
    this.#cancelPayment.push(directive);
    return this;
  }

  scriptGetPayment(directive: FakeGetPaymentDirective): this {
    this.#getPayment.push(directive);
    return this;
  }

  createPayment(
    req: CreatePaymentRequest,
    opts: IdempotentRequestOptions,
  ): Promise<CreatePaymentResponse> {
    this.calls.push({
      method: "create_payment",
      request: req,
      idempotencyKey: opts.idempotencyKey,
    });
    return resolveDirective(this.#createPayment, "create_payment");
  }

  capturePayment(
    req: CapturePaymentRequest,
    opts: IdempotentRequestOptions,
  ): Promise<CapturePaymentResponse> {
    this.calls.push({
      method: "capture_payment",
      request: req,
      idempotencyKey: opts.idempotencyKey,
    });
    return resolveDirective(this.#capturePayment, "capture_payment");
  }

  refundPayment(
    req: RefundPaymentRequest,
    opts: IdempotentRequestOptions,
  ): Promise<RefundPaymentResponse> {
    this.calls.push({
      method: "refund_payment",
      request: req,
      idempotencyKey: opts.idempotencyKey,
    });
    return resolveDirective(this.#refundPayment, "refund_payment");
  }

  cancelPayment(
    req: CancelPaymentRequest,
    opts: IdempotentRequestOptions,
  ): Promise<CancelPaymentResponse> {
    this.calls.push({
      method: "cancel_payment",
      request: req,
      idempotencyKey: opts.idempotencyKey,
    });
    return resolveDirective(this.#cancelPayment, "cancel_payment");
  }

  getPayment(
    paymentId: string,
    _opts?: RequestOptions,
  ): Promise<PaymentSnapshot> {
    this.calls.push({
      method: "get_payment",
      request: { paymentId },
      idempotencyKey: undefined,
    });
    return resolveDirective(this.#getPayment, "get_payment");
  }
}

/**
 * Resolves the next queued directive synchronously and wraps the outcome in
 * a `Promise` — deliberately NOT an `async` function: with no `await`
 * inside, marking it `async` would trip `@typescript-eslint/require-await`
 * (this file isn't under `**\/adapters/**` or `*.test.ts`, so that rule isn't
 * relaxed for it in `eslint.config.js`).
 */
function resolveDirective<TResponse>(
  queue: (
    | { readonly kind: "resolve"; readonly response: TResponse }
    | { readonly kind: "reject"; readonly error: Error }
  )[],
  method: PayCoreOperation,
): Promise<TResponse> {
  const directive = queue.shift();
  if (directive === undefined) {
    return Promise.reject(
      new Error(
        `FakePayCoreClient: no directive scripted for "${method}" — call the matching script*(...) method before invoking it in a test.`,
      ),
    );
  }
  if (directive.kind === "reject") {
    return Promise.reject(directive.error);
  }
  return Promise.resolve(directive.response);
}
