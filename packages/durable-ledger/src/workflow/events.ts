import { z } from "zod";
import { eventType } from "inngest";

/**
 * The event that starts the `payment.execute` workflow (`./payment-execute.js`).
 * `eventType` (confirmed against the installed `inngest@4.20.0` — it accepts
 * a Standard-Schema-compatible schema, and Zod v3/v4 schemas satisfy that
 * out of the box) both types the trigger AND gives callers a validated
 * `paymentExecuteRequested.create(data)` helper for building the event to
 * send, so `inngest.send(...)` and this function's trigger can never drift
 * on shape.
 */
export const paymentExecuteRequestedSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  paymentMethodToken: z.string().min(1),
  merchantId: z.string().min(1),
});

export type PaymentExecuteRequested = z.infer<
  typeof paymentExecuteRequestedSchema
>;

export const paymentExecuteRequested = eventType("payment/execute.requested", {
  schema: paymentExecuteRequestedSchema,
});
