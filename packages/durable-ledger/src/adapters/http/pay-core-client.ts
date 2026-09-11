import type { ZodType } from "zod";
import type {
  CancelPaymentRequest,
  CancelPaymentResponse,
  CapturePaymentRequest,
  CapturePaymentResponse,
  CreatePaymentRequest,
  CreatePaymentResponse,
  IdempotentRequestOptions,
  PaymentSnapshot,
  PayCoreClient,
  PayCoreOperation,
  RefundPaymentRequest,
  RefundPaymentResponse,
  RequestOptions,
} from "../../ports/pay-core-client.js";
import {
  PayCoreClientError,
  PayCoreMalformedResponseError,
  PayCoreNetworkError,
  PayCoreRequestCanceledError,
  PayCoreTimeoutError,
} from "../../ports/pay-core-errors.js";
import { payCoreErrorFor } from "./error-mapper.js";
import {
  cancelPaymentResponseSchema,
  capturePaymentResponseSchema,
  createPaymentResponseSchema,
  paymentSnapshotSchema,
  refundPaymentResponseSchema,
} from "./pay-core-schemas.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * `AbortSignal.timeout`/`.any` are supported at runtime on Node 24 (this
 * package's minimum), but this monorepo's root `tsconfig.base.json`
 * (`lib: ["ES2023"]`, no `dom`) — out of this step's scope to change —
 * resolves `@types/node`'s ambient `AbortSignal` static type without those
 * two static methods. A narrow local cast, used only at the two call sites
 * below that need them.
 */
interface AbortSignalStatics {
  timeout(milliseconds: number): AbortSignal;
  any(signals: AbortSignal[]): AbortSignal;
}
const AbortSignalStatics = AbortSignal as unknown as typeof AbortSignal &
  AbortSignalStatics;

export interface HttpPayCoreClientOptions {
  /** No default — every caller must say which pay-core instance to talk to. May include a path prefix (e.g. `http://localhost:3000/api`). */
  readonly baseUrl: string;
  /** Falls back to `DEFAULT_REQUEST_TIMEOUT_MS` when unset; a per-call `RequestOptions.timeoutMs` overrides this. */
  readonly timeoutMs?: number;
}

interface RequestParams<T> {
  readonly operation: PayCoreOperation;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body: unknown;
  readonly idempotencyKey: string | undefined;
  readonly schema: ZodType<T>;
  readonly timeoutMs: number | undefined;
  readonly signal: AbortSignal | undefined;
}

/**
 * `fetch`-based `PayCoreClient` implementation (Node 24 built-in `fetch`, no
 * new HTTP dependency). All five methods funnel through one private
 * `request<T>` helper that builds the URL/headers/body, applies the timeout
 * (combined with any caller-supplied `AbortSignal`), validates the response
 * against the matching zod schema, and maps non-2xx responses through
 * `payCoreErrorFor`.
 */
export class HttpPayCoreClient implements PayCoreClient {
  private readonly baseUrl: string;

  constructor(private readonly options: HttpPayCoreClientOptions) {
    this.baseUrl = options.baseUrl.endsWith("/")
      ? options.baseUrl.slice(0, -1)
      : options.baseUrl;
  }

  async createPayment(
    req: CreatePaymentRequest,
    opts: IdempotentRequestOptions,
  ): Promise<CreatePaymentResponse> {
    return this.request({
      operation: "create_payment",
      method: "POST",
      path: "/payments",
      body: { ...req },
      idempotencyKey: opts.idempotencyKey,
      schema: createPaymentResponseSchema,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
  }

  async capturePayment(
    req: CapturePaymentRequest,
    opts: IdempotentRequestOptions,
  ): Promise<CapturePaymentResponse> {
    return this.request({
      operation: "capture_payment",
      method: "POST",
      path: `/payments/${encodeURIComponent(req.paymentId)}/capture`,
      body: { ...(req.amount === undefined ? {} : { amount: req.amount }) },
      idempotencyKey: opts.idempotencyKey,
      schema: capturePaymentResponseSchema,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
  }

  async refundPayment(
    req: RefundPaymentRequest,
    opts: IdempotentRequestOptions,
  ): Promise<RefundPaymentResponse> {
    return this.request({
      operation: "refund_payment",
      method: "POST",
      path: `/payments/${encodeURIComponent(req.paymentId)}/refund`,
      body: { amount: req.amount },
      idempotencyKey: opts.idempotencyKey,
      schema: refundPaymentResponseSchema,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
  }

  async cancelPayment(
    req: CancelPaymentRequest,
    opts: IdempotentRequestOptions,
  ): Promise<CancelPaymentResponse> {
    return this.request({
      operation: "cancel_payment",
      method: "POST",
      path: `/payments/${encodeURIComponent(req.paymentId)}/cancel`,
      body: undefined,
      idempotencyKey: opts.idempotencyKey,
      schema: cancelPaymentResponseSchema,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
  }

  async getPayment(
    paymentId: string,
    opts?: RequestOptions,
  ): Promise<PaymentSnapshot> {
    return this.request({
      operation: "get_payment",
      method: "GET",
      path: `/payments/${encodeURIComponent(paymentId)}`,
      body: undefined,
      idempotencyKey: undefined,
      schema: paymentSnapshotSchema,
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
    });
  }

  private async request<T>(params: RequestParams<T>): Promise<T> {
    const { operation, method, path, body, idempotencyKey, schema } = params;
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    const timeoutMs =
      params.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timeoutSignal = AbortSignalStatics.timeout(timeoutMs);
    const callerSignal = params.signal;
    const combinedSignal =
      callerSignal === undefined
        ? timeoutSignal
        : AbortSignalStatics.any([timeoutSignal, callerSignal]);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combinedSignal,
      });
    } catch (err) {
      throw this.classifyFetchError(
        operation,
        err,
        combinedSignal,
        callerSignal,
        timeoutMs,
      );
    }

    const bodyText = await response.text();

    if (!response.ok) {
      throw payCoreErrorFor(operation, {
        status: response.status,
        bodyText,
        retryAfter: response.headers.get("Retry-After"),
      });
    }

    return this.parseSuccess(operation, response.status, bodyText, schema);
  }

  private parseSuccess<T>(
    operation: PayCoreOperation,
    status: number,
    bodyText: string,
    schema: ZodType<T>,
  ): T {
    let json: unknown;
    try {
      json = bodyText.trim() === "" ? {} : JSON.parse(bodyText);
    } catch {
      throw new PayCoreMalformedResponseError(
        `pay-core ${operation} returned a ${status} response with a non-JSON body`,
        { operation, status, payCoreCode: undefined },
      );
    }

    const result = schema.safeParse(json);
    if (!result.success) {
      throw new PayCoreMalformedResponseError(
        `pay-core ${operation} returned a ${status} response that did not match the expected schema`,
        { operation, status, payCoreCode: undefined },
      );
    }
    return result.data;
  }

  /**
   * `fetch` rejected before any response arrived. `combinedSignal.aborted`
   * distinguishes an abort-caused rejection (ours or the caller's) from a
   * genuine transport failure (connection refused, DNS, socket reset) —
   * only an abort sets it. Among aborts, `callerSignal.aborted` tells us
   * WHICH signal fired: the caller's own `AbortSignal` (canceled, terminal)
   * or our timeout (retryable) — never confused with one another.
   */
  private classifyFetchError(
    operation: PayCoreOperation,
    err: unknown,
    combinedSignal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): PayCoreClientError {
    if (combinedSignal.aborted) {
      if (callerSignal !== undefined && callerSignal.aborted) {
        return new PayCoreRequestCanceledError(
          `pay-core ${operation} request was canceled by the caller`,
          { operation, status: undefined, payCoreCode: undefined },
        );
      }
      return new PayCoreTimeoutError(
        `pay-core ${operation} timed out after ${timeoutMs}ms`,
        { operation, status: undefined, payCoreCode: undefined },
        timeoutMs,
      );
    }
    return new PayCoreNetworkError(`pay-core ${operation} request failed`, {
      operation,
      status: undefined,
      payCoreCode: undefined,
      cause: err,
    });
  }
}
