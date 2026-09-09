import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import {
  createInMemoryPayCore,
  type PayCoreUseCases,
} from "../../composition-root.js";
import { MockProvider } from "../mock/mock-provider.js";
import {
  ProviderDeclinedError,
  ProviderUnavailableError,
  type AuthorizeParams,
  type AuthorizeResult,
  type CancelParams,
  type CaptureParams,
  type PaymentProvider,
  type RefundParams,
} from "../../ports/payment-provider.js";

const CLOCK = () => new Date("2026-07-01T00:00:00Z");

/**
 * A ~15-line scripted provider whose `capture` behavior is controlled per
 * test. Neither `SimulatorProvider` nor `MockProvider` can make authorize
 * succeed while capture fails (the simulator encodes its directive into the
 * minted `providerRef` itself), so this local double fills that gap.
 */
class ScriptedProvider implements PaymentProvider {
  readonly name = "scripted";
  constructor(private readonly onCapture: () => Promise<void>) {}

  async authorize(_params: AuthorizeParams): Promise<AuthorizeResult> {
    return { providerRef: `scripted_${randomUUID()}` };
  }

  async capture(_params: CaptureParams): Promise<void> {
    await this.onCapture();
  }

  async refund(_params: RefundParams): Promise<void> {
    // not exercised by these tests
  }

  async cancel(_params: CancelParams): Promise<void> {
    // not exercised by these tests
  }
}

function buildApp(provider: PaymentProvider = new MockProvider()): {
  app: Hono;
  core: PayCoreUseCases & { readonly repository: { outbox: unknown[] } };
} {
  const core = createInMemoryPayCore({ provider, clock: CLOCK });
  return { app: createApp(core), core };
}

async function createAuthorizedPayment(
  app: Hono,
  overrides: { amount?: number; idempotencyKey?: string } = {},
): Promise<string> {
  const res = await app.request("/payments", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": overrides.idempotencyKey ?? `create-${randomUUID()}`,
    },
    body: JSON.stringify({
      amount: overrides.amount ?? 2000,
      currency: "USD",
      paymentMethodToken: "tok_visa",
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; status: string };
  expect(body.status).toBe("authorized");
  return body.id;
}

describe("createApp", () => {
  describe("GET /healthz", () => {
    it("returns 200 with a static ok body", async () => {
      const { app } = buildApp();
      const res = await app.request("/healthz");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });
  });

  describe("POST /payments", () => {
    it("authorizes a payment on the happy path", async () => {
      const { app } = buildApp();
      const res = await app.request("/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "key-1",
        },
        body: JSON.stringify({
          amount: 2000,
          currency: "USD",
          paymentMethodToken: "tok_visa",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("authorized");
    });

    it("returns 400 missing_idempotency_key when the header is absent", async () => {
      const { app } = buildApp();
      const res = await app.request("/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: 2000,
          currency: "USD",
          paymentMethodToken: "tok_visa",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("missing_idempotency_key");
    });

    it("returns 400 validation_failed with details for both bad fields", async () => {
      const { app } = buildApp();
      const res = await app.request("/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "key-invalid",
        },
        body: JSON.stringify({
          amount: -5,
          currency: "usd",
          paymentMethodToken: "tok_visa",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details: { path: string }[] };
      };
      expect(body.error.code).toBe("validation_failed");
      const paths = body.error.details.map((d) => d.path);
      expect(paths).toContain("amount");
      expect(paths).toContain("currency");
    });

    it("returns 400 invalid_json for a malformed body", async () => {
      const { app } = buildApp();
      const res = await app.request("/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "key-bad-json",
        },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_json");
    });

    it("replays an identical result for a retry with the same key + body without a second effect", async () => {
      const { app, core } = buildApp();
      const payload = JSON.stringify({
        amount: 2000,
        currency: "USD",
        paymentMethodToken: "tok_visa",
      });
      const headers = {
        "Content-Type": "application/json",
        "Idempotency-Key": "key-replay",
      };

      const first = await app.request("/payments", {
        method: "POST",
        headers,
        body: payload,
      });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { id: string };
      const outboxAfterFirst = core.repository.outbox.length;

      const second = await app.request("/payments", {
        method: "POST",
        headers,
        body: payload,
      });
      expect(second.status).toBe(201);
      const secondBody = (await second.json()) as { id: string };

      expect(secondBody.id).toBe(firstBody.id);
      expect(core.repository.outbox.length).toBe(outboxAfterFirst);
    });

    it("returns 409 idempotency_conflict for the same key with a different body", async () => {
      const { app } = buildApp();
      const headers = {
        "Content-Type": "application/json",
        "Idempotency-Key": "key-conflict",
      };
      const first = await app.request("/payments", {
        method: "POST",
        headers,
        body: JSON.stringify({
          amount: 2000,
          currency: "USD",
          paymentMethodToken: "tok_visa",
        }),
      });
      expect(first.status).toBe(201);

      const second = await app.request("/payments", {
        method: "POST",
        headers,
        body: JSON.stringify({
          amount: 3000,
          currency: "USD",
          paymentMethodToken: "tok_visa",
        }),
      });
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: { code: string } };
      expect(body.error.code).toBe("idempotency_conflict");
    });

    it("returns 201 with status failed when the provider declines authorize (anti-regression)", async () => {
      const { app } = buildApp();
      // MockProvider declines any amount whose minor units end in 13.
      const res = await app.request("/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "key-decline",
        },
        body: JSON.stringify({
          amount: 1013,
          currency: "USD",
          paymentMethodToken: "tok_visa",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("failed");
    });
  });

  describe("POST /payments/:id/capture", () => {
    it("captures the full authorized amount when no body is sent", async () => {
      const { app } = buildApp();
      const id = await createAuthorizedPayment(app, { amount: 2000 });

      const res = await app.request(`/payments/${id}/capture`, {
        method: "POST",
        headers: { "Idempotency-Key": "cap-1" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        capturedAmount: number;
      };
      expect(body.status).toBe("captured");
      expect(body.capturedAmount).toBe(2000);
    });

    it("supports a partial capture", async () => {
      const { app } = buildApp();
      const id = await createAuthorizedPayment(app, { amount: 2000 });

      const res = await app.request(`/payments/${id}/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "cap-partial",
        },
        body: JSON.stringify({ amount: 500 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { capturedAmount: number };
      expect(body.capturedAmount).toBe(500);
    });

    it("returns 422 amount_exceeded when capturing more than authorized", async () => {
      const { app } = buildApp();
      const id = await createAuthorizedPayment(app, { amount: 2000 });

      const res = await app.request(`/payments/${id}/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "cap-over",
        },
        body: JSON.stringify({ amount: 3000 }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("amount_exceeded");
    });

    it("returns 422 illegal_state_transition when capturing an already-fully-captured payment", async () => {
      const { app } = buildApp();
      const id = await createAuthorizedPayment(app, { amount: 2000 });
      await app.request(`/payments/${id}/capture`, {
        method: "POST",
        headers: { "Idempotency-Key": "cap-first" },
      });

      const res = await app.request(`/payments/${id}/capture`, {
        method: "POST",
        headers: { "Idempotency-Key": "cap-second" },
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("illegal_state_transition");
    });

    it("returns 404 for an unknown payment id", async () => {
      const { app } = buildApp();
      const res = await app.request(`/payments/${randomUUID()}/capture`, {
        method: "POST",
        headers: { "Idempotency-Key": "cap-missing" },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("payment_not_found");
    });

    it("returns 400 validation_failed for a non-UUID :id", async () => {
      const { app } = buildApp();
      const res = await app.request("/payments/not-a-uuid/capture", {
        method: "POST",
        headers: { "Idempotency-Key": "cap-bad-id" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    });
  });

  describe("POST /payments/:id/refund", () => {
    async function createCapturedPayment(
      app: Hono,
      amount = 2000,
    ): Promise<string> {
      const id = await createAuthorizedPayment(app, { amount });
      const res = await app.request(`/payments/${id}/capture`, {
        method: "POST",
        headers: { "Idempotency-Key": `cap-for-${id}` },
      });
      expect(res.status).toBe(200);
      return id;
    }

    it("refunds on the happy path", async () => {
      const { app } = buildApp();
      const id = await createCapturedPayment(app, 2000);

      const res = await app.request(`/payments/${id}/refund`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "ref-1",
        },
        body: JSON.stringify({ amount: 500 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { refundedAmount: number };
      expect(body.refundedAmount).toBe(500);
    });

    it("returns 422 amount_exceeded on an over-refund", async () => {
      const { app } = buildApp();
      const id = await createCapturedPayment(app, 2000);

      const res = await app.request(`/payments/${id}/refund`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "ref-over",
        },
        body: JSON.stringify({ amount: 3000 }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("amount_exceeded");
    });

    it("returns 422 illegal_state_transition refunding an authorized (never-captured) payment", async () => {
      const { app } = buildApp();
      const id = await createAuthorizedPayment(app, { amount: 2000 });

      const res = await app.request(`/payments/${id}/refund`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "ref-uncaptured",
        },
        body: JSON.stringify({ amount: 500 }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("illegal_state_transition");
    });
  });

  describe("POST /payments/:id/cancel", () => {
    it("cancels on the happy path", async () => {
      const { app } = buildApp();
      const id = await createAuthorizedPayment(app, { amount: 2000 });

      const res = await app.request(`/payments/${id}/cancel`, {
        method: "POST",
        headers: { "Idempotency-Key": "cancel-1" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("canceled");
    });

    it("ignores a request body instead of rejecting it", async () => {
      const { app } = buildApp();
      const id = await createAuthorizedPayment(app, { amount: 2000 });

      const res = await app.request(`/payments/${id}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "cancel-with-body",
        },
        body: JSON.stringify({ unexpected: "field" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("canceled");
    });
  });

  describe("provider-error routes", () => {
    it("returns 402 provider_declined when the provider declines capture", async () => {
      const provider = new ScriptedProvider(async () => {
        throw new ProviderDeclinedError("card declined");
      });
      const { app } = buildApp(provider);
      const id = await createAuthorizedPayment(app, { amount: 2000 });

      const res = await app.request(`/payments/${id}/capture`, {
        method: "POST",
        headers: { "Idempotency-Key": "cap-declined" },
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("provider_declined");
    });

    it("returns 503 provider_unavailable with Retry-After when the provider is unavailable", async () => {
      const provider = new ScriptedProvider(async () => {
        throw new ProviderUnavailableError("timeout", 2000);
      });
      const { app } = buildApp(provider);
      const id = await createAuthorizedPayment(app, { amount: 2000 });

      const res = await app.request(`/payments/${id}/capture`, {
        method: "POST",
        headers: { "Idempotency-Key": "cap-unavailable" },
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("2");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("provider_unavailable");
    });

    it("returns a generic 500 for an unexpected provider error, leaking nothing", async () => {
      const secretMessage = "unexpected: database credentials leaked here";
      const provider = new ScriptedProvider(async () => {
        throw new Error(secretMessage);
      });
      const { app } = buildApp(provider);
      const id = await createAuthorizedPayment(app, { amount: 2000 });

      const res = await app.request(`/payments/${id}/capture`, {
        method: "POST",
        headers: { "Idempotency-Key": "cap-unexpected" },
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain(secretMessage);
      expect(JSON.parse(text)).toEqual({
        error: { code: "internal_error", message: "Internal server error" },
      });
    });
  });

  describe("GET /payments/:id", () => {
    it("returns the payment with an ISO-8601 createdAt", async () => {
      const { app } = buildApp();
      const id = await createAuthorizedPayment(app, { amount: 2000 });

      const res = await app.request(`/payments/${id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; createdAt: string };
      expect(body.id).toBe(id);
      expect(body.createdAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
      );
    });

    it("returns 404 for an unknown payment id", async () => {
      const { app } = buildApp();
      const res = await app.request(`/payments/${randomUUID()}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("payment_not_found");
    });
  });

  describe("app.notFound", () => {
    it("returns a JSON error envelope for an unknown route", async () => {
      const { app } = buildApp();
      const res = await app.request("/some/nonexistent/route");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("not_found");
    });
  });
});
