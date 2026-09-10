import { Hono } from "hono";
import type { PayCoreUseCases } from "../../composition-root.js";
import type { CreatePaymentCommand } from "../../app/create-payment.js";
import type { CapturePaymentCommand } from "../../app/capture-payment.js";
import type { RefundPaymentCommand } from "../../app/refund-payment.js";
import type { CancelPaymentCommand } from "../../app/cancel-payment.js";
import {
  PaymentIdParam,
  CreatePaymentBody,
  CapturePaymentBody,
  RefundPaymentBody,
} from "./schemas.js";
import { requireIdempotencyKey, readJsonBody } from "./request.js";
import { mapError } from "./error-mapper.js";

/**
 * Builds the driving HTTP adapter: a Hono `app` wired against `PayCoreUseCases`.
 * Route handlers stay small — read param, validate/parse, read the body, call
 * the use-case, return the result as-is — and never catch: every error
 * propagates to the single `app.onError` below, which maps it through
 * `mapError`. There is no separate DTO/response-mapping layer; use-case
 * results are already flat and JSON-safe (Hono serializes `Date` fields to
 * ISO-8601 strings).
 */
export function createApp(core: PayCoreUseCases): Hono {
  const app = new Hono();

  app.post("/payments", async (c) => {
    const idempotencyKey = requireIdempotencyKey(c);
    const body = CreatePaymentBody.parse(await readJsonBody(c));
    const command: CreatePaymentCommand = { ...body, idempotencyKey };
    const result = await core.createPayment(command);
    return c.json(result, 201);
  });

  app.post("/payments/:id/capture", async (c) => {
    const paymentId = PaymentIdParam.parse(c.req.param("id"));
    const idempotencyKey = requireIdempotencyKey(c);
    const body = CapturePaymentBody.parse(await readJsonBody(c));
    const command: CapturePaymentCommand = {
      paymentId,
      idempotencyKey,
      ...(body.amount === undefined ? {} : { amount: body.amount }),
    };
    const result = await core.capturePayment(command);
    return c.json(result, 200);
  });

  app.post("/payments/:id/refund", async (c) => {
    const paymentId = PaymentIdParam.parse(c.req.param("id"));
    const idempotencyKey = requireIdempotencyKey(c);
    const body = RefundPaymentBody.parse(await readJsonBody(c));
    const command: RefundPaymentCommand = {
      paymentId,
      idempotencyKey,
      amount: body.amount,
    };
    const result = await core.refundPayment(command);
    return c.json(result, 200);
  });

  app.post("/payments/:id/cancel", async (c) => {
    const paymentId = PaymentIdParam.parse(c.req.param("id"));
    const idempotencyKey = requireIdempotencyKey(c);
    const command: CancelPaymentCommand = { paymentId, idempotencyKey };
    const result = await core.cancelPayment(command);
    return c.json(result, 200);
  });

  app.get("/payments/:id", async (c) => {
    const paymentId = PaymentIdParam.parse(c.req.param("id"));
    const result = await core.getPayment(paymentId);
    return c.json(result, 200);
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }, 200));

  app.onError((err, c) => {
    const { status, body, headers } = mapError(err);
    return c.json(body, status, headers);
  });

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "Not found" } }, 404),
  );

  return app;
}
