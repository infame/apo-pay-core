import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/**
 * Test support only — deliberately NOT exported from `src/index.ts`. The
 * wire contract implemented below is transcribed from
 * `packages/pay-core/src/adapters/http/app.ts` and
 * `packages/pay-core/src/adapters/http/error-mapper.ts`; if pay-core's real
 * contract ever drifts from this fake, those two files are where to check
 * first. See ADR-0006 for why tests exercise a real `node:http` server over
 * real sockets rather than importing pay-core in-process.
 */

export interface FakeRequestContext {
  readonly method: string;
  /** Raw path (no query string), e.g. `/payments/123/capture`. Never decoded — a `%2F` in an id stays a `%2F`. */
  readonly path: string;
  /** First-seen casing per header name, as received on the wire. */
  readonly headers: Record<string, string>;
  readonly body: string;
  /** Decoded `:id` path segment, when the route has one. */
  readonly paymentId: string | undefined;
}

/** Full control of the response — a test override can write any status/headers/body, delay before responding, or destroy the socket directly via `res`. */
export type RouteHandler = (
  ctx: FakeRequestContext,
  res: ServerResponse,
) => void | Promise<void>;

export interface RouteHandlers {
  createPayment: RouteHandler;
  capturePayment: RouteHandler;
  refundPayment: RouteHandler;
  cancelPayment: RouteHandler;
  getPayment: RouteHandler;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface FakePayCoreServer {
  readonly baseUrl: string;
  close(): Promise<void>;
  readonly requests: RecordedRequest[];
}

/** A plain status/body/headers triple — what the DEFAULT handlers compute before being wired to a real `res`. */
interface FakeResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...(headers ?? {}),
  });
  res.end(text);
}

/** Wraps a pure `ctx -> FakeResponse` default handler as a real `RouteHandler` that writes it to `res`. */
function wireDefaultHandler(
  handler: (ctx: FakeRequestContext) => FakeResponse,
): RouteHandler {
  return (ctx, res) => {
    const { status, body, headers } = handler(ctx);
    sendJson(res, status, body, headers);
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function parseJsonBody(bodyText: string): Record<string, unknown> {
  if (bodyText.trim() === "") {
    return {};
  }
  try {
    return asRecord(JSON.parse(bodyText));
  } catch {
    return {};
  }
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key];
    }
  }
  return undefined;
}

function buildHeaderRecord(rawHeaders: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (name !== undefined && value !== undefined && !(name in record)) {
      record[name] = value;
    }
  }
  return record;
}

interface PaymentRecord {
  id: string;
  status: string;
  currency: string;
  amountAuthorized: number;
  capturedAmount: number;
  refundedAmount: number;
  providerRef: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface IdempotencyRecord {
  readonly bodyText: string;
  readonly response: FakeResponse;
}

/**
 * Minimal `(idempotencyKey, operation) -> stored response` replay, enough to
 * let tests prove the client transmits `Idempotency-Key` such that a
 * real-pay-core-shaped replay works: same key + same body returns the SAME
 * stored response without recomputing; same key + a different body is a 409
 * conflict, mirroring pay-core's `IdempotencyConflictError`.
 */
function withIdempotency(
  store: Map<string, IdempotencyRecord>,
  idempotencyKey: string,
  operation: string,
  bodyText: string,
  compute: () => FakeResponse,
): FakeResponse {
  const mapKey = `${idempotencyKey}:${operation}`;
  const existing = store.get(mapKey);
  if (existing !== undefined) {
    if (existing.bodyText === bodyText) {
      return existing.response;
    }
    return {
      status: 409,
      body: {
        error: {
          code: "idempotency_conflict",
          message: `Idempotency key "${idempotencyKey}" was reused with a different request`,
        },
      },
    };
  }
  const response = compute();
  store.set(mapKey, { bodyText, response });
  return response;
}

function requireIdempotencyKey(ctx: FakeRequestContext): string | undefined {
  const key = headerValue(ctx.headers, "Idempotency-Key");
  return key === undefined || key.trim() === "" ? undefined : key;
}

const MISSING_IDEMPOTENCY_KEY_RESPONSE: FakeResponse = {
  status: 400,
  body: {
    error: {
      code: "missing_idempotency_key",
      message: "Idempotency-Key header is required",
    },
  },
};

function notFound(paymentId: string | undefined): FakeResponse {
  return {
    status: 404,
    body: {
      error: {
        code: "payment_not_found",
        message: `Payment "${paymentId ?? ""}" not found`,
      },
    },
  };
}

function routeNotFound(): FakeResponse {
  return {
    status: 404,
    body: { error: { code: "not_found", message: "Not found" } },
  };
}

/** Pure default handlers, closing over one server instance's payment/idempotency state. Wired to real `RouteHandler`s in `startFakePayCore`. */
function createDefaultHandlers(
  payments: Map<string, PaymentRecord>,
  idempotencyStore: Map<string, IdempotencyRecord>,
): Record<keyof RouteHandlers, (ctx: FakeRequestContext) => FakeResponse> {
  return {
    createPayment(ctx) {
      const idempotencyKey = requireIdempotencyKey(ctx);
      if (idempotencyKey === undefined) {
        return MISSING_IDEMPOTENCY_KEY_RESPONSE;
      }
      return withIdempotency(
        idempotencyStore,
        idempotencyKey,
        "create_payment",
        ctx.body,
        () => {
          const parsed = parseJsonBody(ctx.body);
          const amount = typeof parsed.amount === "number" ? parsed.amount : 0;
          const currency =
            typeof parsed.currency === "string" ? parsed.currency : "USD";
          const now = new Date().toISOString();
          const id = randomUUID();
          const record: PaymentRecord = {
            id,
            status: "authorized",
            currency,
            amountAuthorized: amount,
            capturedAmount: 0,
            refundedAmount: 0,
            providerRef: `sim_${id}`,
            failureReason: null,
            createdAt: now,
            updatedAt: now,
          };
          payments.set(id, record);
          return {
            status: 201,
            body: {
              id: record.id,
              status: record.status,
              amount,
              currency: record.currency,
              providerRef: record.providerRef,
            },
          };
        },
      );
    },

    capturePayment(ctx) {
      const idempotencyKey = requireIdempotencyKey(ctx);
      if (idempotencyKey === undefined) {
        return MISSING_IDEMPOTENCY_KEY_RESPONSE;
      }
      const record =
        ctx.paymentId === undefined ? undefined : payments.get(ctx.paymentId);
      if (record === undefined) {
        return notFound(ctx.paymentId);
      }
      return withIdempotency(
        idempotencyStore,
        idempotencyKey,
        "capture_payment",
        ctx.body,
        () => {
          const parsed = parseJsonBody(ctx.body);
          const amount =
            typeof parsed.amount === "number"
              ? parsed.amount
              : record.amountAuthorized;
          record.capturedAmount = amount;
          record.status = "captured";
          record.updatedAt = new Date().toISOString();
          return {
            status: 200,
            body: {
              id: record.id,
              status: record.status,
              currency: record.currency,
              capturedAmount: record.capturedAmount,
              refundedAmount: record.refundedAmount,
            },
          };
        },
      );
    },

    refundPayment(ctx) {
      const idempotencyKey = requireIdempotencyKey(ctx);
      if (idempotencyKey === undefined) {
        return MISSING_IDEMPOTENCY_KEY_RESPONSE;
      }
      const record =
        ctx.paymentId === undefined ? undefined : payments.get(ctx.paymentId);
      if (record === undefined) {
        return notFound(ctx.paymentId);
      }
      return withIdempotency(
        idempotencyStore,
        idempotencyKey,
        "refund_payment",
        ctx.body,
        () => {
          const parsed = parseJsonBody(ctx.body);
          const amount = typeof parsed.amount === "number" ? parsed.amount : 0;
          record.refundedAmount += amount;
          record.status =
            record.refundedAmount >= record.capturedAmount
              ? "refunded"
              : "partially_refunded";
          record.updatedAt = new Date().toISOString();
          return {
            status: 200,
            body: {
              id: record.id,
              status: record.status,
              currency: record.currency,
              capturedAmount: record.capturedAmount,
              refundedAmount: record.refundedAmount,
            },
          };
        },
      );
    },

    cancelPayment(ctx) {
      const idempotencyKey = requireIdempotencyKey(ctx);
      if (idempotencyKey === undefined) {
        return MISSING_IDEMPOTENCY_KEY_RESPONSE;
      }
      const record =
        ctx.paymentId === undefined ? undefined : payments.get(ctx.paymentId);
      if (record === undefined) {
        return notFound(ctx.paymentId);
      }
      return withIdempotency(
        idempotencyStore,
        idempotencyKey,
        "cancel_payment",
        ctx.body,
        () => {
          record.status = "canceled";
          record.updatedAt = new Date().toISOString();
          return {
            status: 200,
            body: { id: record.id, status: record.status },
          };
        },
      );
    },

    getPayment(ctx) {
      const record =
        ctx.paymentId === undefined ? undefined : payments.get(ctx.paymentId);
      if (record === undefined) {
        return notFound(ctx.paymentId);
      }
      return { status: 200, body: { ...record } };
    },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Starts a real `node:http` server on an OS-assigned port (`0`) so tests can
 * run in parallel without port collisions. `overrides` replace individual
 * default route handlers — a test's override gets full control of the
 * `ServerResponse` (force any status, inject `Retry-After`, delay a
 * response, or immediately destroy the socket) without touching the shared
 * in-memory payment/idempotency state the other routes use.
 */
export function startFakePayCore(
  overrides?: Partial<RouteHandlers>,
): Promise<FakePayCoreServer> {
  const payments = new Map<string, PaymentRecord>();
  const idempotencyStore = new Map<string, IdempotencyRecord>();
  const defaults = createDefaultHandlers(payments, idempotencyStore);
  const handlers: RouteHandlers = {
    createPayment: wireDefaultHandler(defaults.createPayment),
    capturePayment: wireDefaultHandler(defaults.capturePayment),
    refundPayment: wireDefaultHandler(defaults.refundPayment),
    cancelPayment: wireDefaultHandler(defaults.cancelPayment),
    getPayment: wireDefaultHandler(defaults.getPayment),
    ...overrides,
  };
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const [rawPath = "/"] = (req.url ?? "/").split("?");
      const headers = buildHeaderRecord(req.rawHeaders);
      const method = req.method ?? "GET";

      requests.push({ method, path: rawPath, headers, body });

      const baseCtx = { method, path: rawPath, headers, body };

      const captureMatch = /^\/payments\/([^/]+)\/capture$/.exec(rawPath);
      const refundMatch = /^\/payments\/([^/]+)\/refund$/.exec(rawPath);
      const cancelMatch = /^\/payments\/([^/]+)\/cancel$/.exec(rawPath);
      const getMatch = /^\/payments\/([^/]+)$/.exec(rawPath);

      try {
        if (method === "POST" && rawPath === "/payments") {
          await handlers.createPayment(
            { ...baseCtx, paymentId: undefined },
            res,
          );
          return;
        }
        if (method === "POST" && captureMatch) {
          await handlers.capturePayment(
            { ...baseCtx, paymentId: decodeSegment(captureMatch[1]) },
            res,
          );
          return;
        }
        if (method === "POST" && refundMatch) {
          await handlers.refundPayment(
            { ...baseCtx, paymentId: decodeSegment(refundMatch[1]) },
            res,
          );
          return;
        }
        if (method === "POST" && cancelMatch) {
          await handlers.cancelPayment(
            { ...baseCtx, paymentId: decodeSegment(cancelMatch[1]) },
            res,
          );
          return;
        }
        if (method === "GET" && getMatch) {
          await handlers.getPayment(
            { ...baseCtx, paymentId: decodeSegment(getMatch[1]) },
            res,
          );
          return;
        }
        const { status, body: notFoundBody } = routeNotFound();
        sendJson(res, status, notFoundBody);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: { code: "internal_error", message: String(err) },
          });
        }
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(
          new Error("startFakePayCore: server did not bind to a TCP port"),
        );
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        requests,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((closeErr) => {
              if (closeErr) {
                rejectClose(closeErr);
              } else {
                resolveClose();
              }
            });
          }),
      });
    });
  });
}

function decodeSegment(segment: string | undefined): string | undefined {
  return segment === undefined ? undefined : decodeURIComponent(segment);
}
