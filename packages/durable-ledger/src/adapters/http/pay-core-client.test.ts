import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PayCoreBadRequestError,
  PayCoreDeclinedError,
  PayCoreIdempotencyConflictError,
  PayCoreIllegalStateError,
  PayCoreMalformedResponseError,
  PayCoreNetworkError,
  PayCoreNotFoundError,
  PayCoreRequestCanceledError,
  PayCoreTimeoutError,
  PayCoreUnavailableError,
  PayCoreUnexpectedResponseError,
} from "../../ports/pay-core-errors.js";
import { HttpPayCoreClient } from "./pay-core-client.js";
import type { FakePayCoreServer } from "./fake-pay-core-server.js";
import { startFakePayCore } from "./fake-pay-core-server.js";

let server: FakePayCoreServer;

afterEach(async () => {
  await server.close();
});

describe("HttpPayCoreClient — happy paths", () => {
  beforeEach(async () => {
    server = await startFakePayCore();
  });

  it("createPayment sends POST /payments with the Idempotency-Key header, JSON content-type, and exactly the three-field body", async () => {
    const client = new HttpPayCoreClient({ baseUrl: server.baseUrl });
    const result = await client.createPayment(
      { amount: 1000, currency: "USD", paymentMethodToken: "tok_visa" },
      { idempotencyKey: "key-1" },
    );

    expect(result.status).toBe("authorized");
    expect(server.requests).toHaveLength(1);
    const req = server.requests[0];
    expect(req).toBeDefined();
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/payments");
    expect(req?.headers["Idempotency-Key"]).toBe("key-1");
    expect(req?.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({
      amount: 1000,
      currency: "USD",
      paymentMethodToken: "tok_visa",
    });
  });

  it("capturePayment with an amount includes it in the body", async () => {
    const client = new HttpPayCoreClient({ baseUrl: server.baseUrl });
    const created = await client.createPayment(
      { amount: 1000, currency: "USD", paymentMethodToken: "tok_visa" },
      { idempotencyKey: randomUUID() },
    );
    await client.capturePayment(
      { paymentId: created.id, amount: 500 },
      { idempotencyKey: randomUUID() },
    );

    const captureReq = server.requests.find((r) => r.path.endsWith("/capture"));
    expect(captureReq).toBeDefined();
    expect(JSON.parse(captureReq?.body ?? "{}")).toEqual({ amount: 500 });
  });

  it("capturePayment without an amount omits the field entirely (not null)", async () => {
    const client = new HttpPayCoreClient({ baseUrl: server.baseUrl });
    const created = await client.createPayment(
      { amount: 1000, currency: "USD", paymentMethodToken: "tok_visa" },
      { idempotencyKey: randomUUID() },
    );
    await client.capturePayment(
      { paymentId: created.id },
      { idempotencyKey: randomUUID() },
    );

    const captureReq = server.requests.find((r) => r.path.endsWith("/capture"));
    const parsed: unknown = JSON.parse(captureReq?.body ?? "{}");
    expect(parsed).toEqual({});
    expect(parsed).not.toHaveProperty("amount");
  });

  it("refundPayment sends the amount in the body", async () => {
    const client = new HttpPayCoreClient({ baseUrl: server.baseUrl });
    const created = await client.createPayment(
      { amount: 1000, currency: "USD", paymentMethodToken: "tok_visa" },
      { idempotencyKey: randomUUID() },
    );
    await client.capturePayment(
      { paymentId: created.id },
      { idempotencyKey: randomUUID() },
    );
    const refunded = await client.refundPayment(
      { paymentId: created.id, amount: 200 },
      { idempotencyKey: randomUUID() },
    );

    expect(refunded.refundedAmount).toBe(200);
    const refundReq = server.requests.find((r) => r.path.endsWith("/refund"));
    expect(JSON.parse(refundReq?.body ?? "{}")).toEqual({ amount: 200 });
  });

  it("cancelPayment sends NO body and no Content-Type header", async () => {
    const client = new HttpPayCoreClient({ baseUrl: server.baseUrl });
    const created = await client.createPayment(
      { amount: 1000, currency: "USD", paymentMethodToken: "tok_visa" },
      { idempotencyKey: randomUUID() },
    );
    await client.cancelPayment(
      { paymentId: created.id },
      { idempotencyKey: randomUUID() },
    );

    const cancelReq = server.requests.find((r) => r.path.endsWith("/cancel"));
    expect(cancelReq).toBeDefined();
    expect(cancelReq?.body).toBe("");
    expect(cancelReq?.headers["Content-Type"]).toBeUndefined();
  });

  it("getPayment returns createdAt/updatedAt as strings, not Dates", async () => {
    const client = new HttpPayCoreClient({ baseUrl: server.baseUrl });
    const created = await client.createPayment(
      { amount: 1000, currency: "USD", paymentMethodToken: "tok_visa" },
      { idempotencyKey: randomUUID() },
    );
    const snapshot = await client.getPayment(created.id);

    expect(typeof snapshot.createdAt).toBe("string");
    expect(typeof snapshot.updatedAt).toBe("string");
    expect(() => new Date(snapshot.createdAt)).not.toThrow();
  });

  it("a 201 response with status: 'failed' does NOT throw — resolves normally (authorize-decline pinning test)", async () => {
    const declineServer = await startFakePayCore({
      createPayment(_ctx, res) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: randomUUID(),
            status: "failed",
            amount: 1000,
            currency: "USD",
            providerRef: null,
          }),
        );
      },
    });
    try {
      const client = new HttpPayCoreClient({ baseUrl: declineServer.baseUrl });
      const result = await client.createPayment(
        { amount: 1000, currency: "USD", paymentMethodToken: "tok_declined" },
        { idempotencyKey: randomUUID() },
      );
      expect(result.status).toBe("failed");
    } finally {
      await declineServer.close();
    }
  });

  it("same Idempotency-Key + same body posted twice returns identical results and only ONE stored effect", async () => {
    const client = new HttpPayCoreClient({ baseUrl: server.baseUrl });
    const key = randomUUID();
    const req = {
      amount: 1000,
      currency: "USD",
      paymentMethodToken: "tok_visa",
    };

    const first = await client.createPayment(req, { idempotencyKey: key });
    const second = await client.createPayment(req, { idempotencyKey: key });

    expect(second).toEqual(first);
    const createRequests = server.requests.filter(
      (r) => r.method === "POST" && r.path === "/payments",
    );
    expect(createRequests).toHaveLength(2); // both requests sent over the wire...
    // ...but the fake's idempotency map only ever computed the effect once,
    // which is exactly why the two parsed bodies are identical (including
    // the same generated `id`) rather than two distinct payments.
    expect(second.id).toBe(first.id);
  });

  it("same Idempotency-Key + different body -> PayCoreIdempotencyConflictError", async () => {
    const client = new HttpPayCoreClient({ baseUrl: server.baseUrl });
    const key = randomUUID();
    await client.createPayment(
      { amount: 1000, currency: "USD", paymentMethodToken: "tok_visa" },
      { idempotencyKey: key },
    );

    await expect(
      client.createPayment(
        { amount: 2000, currency: "USD", paymentMethodToken: "tok_visa" },
        { idempotencyKey: key },
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PayCoreIdempotencyConflictError);
      expect((err as PayCoreIdempotencyConflictError).retryable).toBe(false);
      return true;
    });
  });

  it("unknown payment id on getPayment -> PayCoreNotFoundError, not retryable", async () => {
    const client = new HttpPayCoreClient({ baseUrl: server.baseUrl });
    await expect(client.getPayment(randomUUID())).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(PayCoreNotFoundError);
        expect((err as PayCoreNotFoundError).retryable).toBe(false);
        return true;
      },
    );
  });

  it("URL building: a baseUrl with a trailing slash works", async () => {
    const client = new HttpPayCoreClient({ baseUrl: `${server.baseUrl}/` });
    const result = await client.createPayment(
      { amount: 1000, currency: "USD", paymentMethodToken: "tok_visa" },
      { idempotencyKey: randomUUID() },
    );
    expect(result.status).toBe("authorized");
    expect(server.requests[0]?.path).toBe("/payments");
  });

  it("URL building: a baseUrl with a path prefix is preserved", async () => {
    const prefixServer = await startFakePayCore();
    try {
      const client = new HttpPayCoreClient({
        baseUrl: `${prefixServer.baseUrl}/api`,
      });
      // The fake doesn't route "/api/payments", so this 404s — but the
      // recorded request proves the prefix survived URL building.
      await expect(
        client.createPayment(
          { amount: 1000, currency: "USD", paymentMethodToken: "tok_visa" },
          { idempotencyKey: randomUUID() },
        ),
        // A route-not-found 404 is classified the same way a
        // payment-not-found 404 is — the client can't tell them apart, and
        // shouldn't need to.
      ).rejects.toBeInstanceOf(PayCoreNotFoundError);
      expect(prefixServer.requests[0]?.path).toBe("/api/payments");
    } finally {
      await prefixServer.close();
    }
  });

  it("URL building: a paymentId containing a '/' arrives as one percent-encoded segment", async () => {
    const client = new HttpPayCoreClient({ baseUrl: server.baseUrl });
    const weirdId = "abc/def";
    await expect(client.getPayment(weirdId)).rejects.toBeInstanceOf(
      PayCoreNotFoundError,
    );

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.path).toBe(
      `/payments/${encodeURIComponent(weirdId)}`,
    );
  });
});

describe("HttpPayCoreClient — error classification against the fake wire", () => {
  beforeEach(async () => {
    server = await startFakePayCore();
  });

  it("402 on capture -> PayCoreDeclinedError, not retryable, payCoreCode provider_declined", async () => {
    const declineServer = await startFakePayCore({
      capturePayment(_ctx, res) {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "provider_declined",
              message: "Provider declined: insufficient funds",
            },
          }),
        );
      },
    });
    try {
      const client = new HttpPayCoreClient({ baseUrl: declineServer.baseUrl });
      await expect(
        client.capturePayment(
          { paymentId: randomUUID() },
          { idempotencyKey: randomUUID() },
        ),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(PayCoreDeclinedError);
        expect((err as PayCoreDeclinedError).retryable).toBe(false);
        expect((err as PayCoreDeclinedError).payCoreCode).toBe(
          "provider_declined",
        );
        return true;
      });
    } finally {
      await declineServer.close();
    }
  });

  it("503 with Retry-After: 2 -> PayCoreUnavailableError, retryable, retryAfterMs 2000", async () => {
    const unavailableServer = await startFakePayCore({
      capturePayment(_ctx, res) {
        res.writeHead(503, {
          "Content-Type": "application/json",
          "Retry-After": "2",
        });
        res.end(
          JSON.stringify({
            error: {
              code: "provider_unavailable",
              message: "Provider unavailable",
            },
          }),
        );
      },
    });
    try {
      const client = new HttpPayCoreClient({
        baseUrl: unavailableServer.baseUrl,
      });
      await expect(
        client.capturePayment(
          { paymentId: randomUUID() },
          { idempotencyKey: randomUUID() },
        ),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(PayCoreUnavailableError);
        expect((err as PayCoreUnavailableError).retryable).toBe(true);
        expect((err as PayCoreUnavailableError).retryAfterMs).toBe(2000);
        return true;
      });
    } finally {
      await unavailableServer.close();
    }
  });

  it("422 -> PayCoreIllegalStateError; 400 -> PayCoreBadRequestError with details", async () => {
    const client = new HttpPayCoreClient({ baseUrl: server.baseUrl });
    const created = await client.createPayment(
      { amount: 1000, currency: "USD", paymentMethodToken: "tok_visa" },
      { idempotencyKey: randomUUID() },
    );
    await client.capturePayment(
      { paymentId: created.id },
      { idempotencyKey: randomUUID() },
    );

    // Refunding more than captured -> the fake tracks it loosely, so instead
    // force a 422/400 directly against a dedicated server for determinism.
    const illegalServer = await startFakePayCore({
      refundPayment(_ctx, res) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "illegal_state_transition",
              message: 'Cannot refund a payment in state "failed"',
            },
          }),
        );
      },
      capturePayment(_ctx, res) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "validation_failed",
              message: "Request validation failed",
              details: [{ path: "amount", message: "Required" }],
            },
          }),
        );
      },
    });
    try {
      const illegalClient = new HttpPayCoreClient({
        baseUrl: illegalServer.baseUrl,
      });
      await expect(
        illegalClient.refundPayment(
          { paymentId: created.id, amount: 100 },
          { idempotencyKey: randomUUID() },
        ),
      ).rejects.toBeInstanceOf(PayCoreIllegalStateError);

      await expect(
        illegalClient.capturePayment(
          { paymentId: created.id },
          { idempotencyKey: randomUUID() },
        ),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(PayCoreBadRequestError);
        expect((err as PayCoreBadRequestError).details).toEqual([
          { path: "amount", message: "Required" },
        ]);
        return true;
      });
    } finally {
      await illegalServer.close();
    }
  });

  it("connection refused -> PayCoreNetworkError, retryable", async () => {
    const client = new HttpPayCoreClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(client.getPayment(randomUUID())).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(PayCoreNetworkError);
        expect((err as PayCoreNetworkError).retryable).toBe(true);
        return true;
      },
    );
  });

  it("a delayed response + timeoutMs rejects PROMPTLY with PayCoreTimeoutError, retryable", async () => {
    const slowServer = await startFakePayCore({
      getPayment(_ctx, res) {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: randomUUID(),
              status: "authorized",
              currency: "USD",
              amountAuthorized: 1000,
              capturedAmount: 0,
              refundedAmount: 0,
              providerRef: "sim_x",
              failureReason: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }),
          );
        }, 500);
      },
    });
    try {
      const client = new HttpPayCoreClient({ baseUrl: slowServer.baseUrl });
      const start = Date.now();
      await expect(
        client.getPayment(randomUUID(), { timeoutMs: 20 }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(PayCoreTimeoutError);
        expect((err as PayCoreTimeoutError).retryable).toBe(true);
        return true;
      });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(300);
    } finally {
      await slowServer.close();
    }
  });

  it("a caller-supplied AbortSignal aborted mid-flight -> PayCoreRequestCanceledError, distinguishable from a timeout", async () => {
    const slowServer = await startFakePayCore({
      getPayment(_ctx, res) {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }, 500);
      },
    });
    try {
      const client = new HttpPayCoreClient({ baseUrl: slowServer.baseUrl });
      const controller = new AbortController();
      const promise = client.getPayment(randomUUID(), {
        signal: controller.signal,
        timeoutMs: 5000,
      });
      setTimeout(() => {
        controller.abort();
      }, 20);

      await expect(promise).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(PayCoreRequestCanceledError);
        expect(err).not.toBeInstanceOf(PayCoreTimeoutError);
        expect((err as PayCoreRequestCanceledError).retryable).toBe(false);
        return true;
      });
    } finally {
      await slowServer.close();
    }
  });

  it("a 200 response missing a required field -> PayCoreMalformedResponseError, not retryable", async () => {
    const malformedServer = await startFakePayCore({
      capturePayment(_ctx, res) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: randomUUID(),
            status: "captured",
            currency: "USD",
            // capturedAmount deliberately dropped
            refundedAmount: 0,
          }),
        );
      },
    });
    try {
      const client = new HttpPayCoreClient({
        baseUrl: malformedServer.baseUrl,
      });
      await expect(
        client.capturePayment(
          { paymentId: randomUUID() },
          { idempotencyKey: randomUUID() },
        ),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(PayCoreMalformedResponseError);
        expect((err as PayCoreMalformedResponseError).retryable).toBe(false);
        return true;
      });
    } finally {
      await malformedServer.close();
    }
  });

  it("a 500 with a non-JSON (HTML) body -> PayCoreUnexpectedResponseError, retryable, no parse-time throw", async () => {
    const htmlServer = await startFakePayCore({
      getPayment(_ctx, res) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end("<html><body>Internal Server Error</body></html>");
      },
    });
    try {
      const client = new HttpPayCoreClient({ baseUrl: htmlServer.baseUrl });
      await expect(client.getPayment(randomUUID())).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(PayCoreUnexpectedResponseError);
          expect((err as PayCoreUnexpectedResponseError).retryable).toBe(true);
          return true;
        },
      );
    } finally {
      await htmlServer.close();
    }
  });
});
