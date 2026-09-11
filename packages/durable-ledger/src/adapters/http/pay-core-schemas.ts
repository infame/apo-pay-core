import { z } from "zod";
import type {
  CancelPaymentResponse,
  CapturePaymentResponse,
  CreatePaymentResponse,
  PaymentSnapshot,
  RefundPaymentResponse,
} from "../../ports/pay-core-client.js";
import type { PayCoreErrorEnvelope } from "./error-mapper.js";

/**
 * Response-validation schemas for `HttpPayCoreClient`. Each is typed as
 * `z.ZodType<PortType>` so the compiler rejects any drift between the schema
 * and the port's own response type in `src/ports/pay-core-client.ts` — a
 * missing/mistyped field here is a compile error, not a runtime surprise.
 * Unknown keys are stripped, not rejected (no `.strict()`), matching
 * pay-core's own forward-compatibility choice for its request schemas
 * (`packages/pay-core/src/adapters/http/schemas.ts`).
 */

const paymentStatusSchema = z.enum([
  "created",
  "authorized",
  "captured",
  "partially_refunded",
  "refunded",
  "failed",
  "canceled",
]);

export const createPaymentResponseSchema: z.ZodType<CreatePaymentResponse> =
  z.object({
    id: z.string(),
    status: paymentStatusSchema,
    amount: z.number(),
    currency: z.string(),
    providerRef: z.string().nullable(),
  });

export const capturePaymentResponseSchema: z.ZodType<CapturePaymentResponse> =
  z.object({
    id: z.string(),
    status: paymentStatusSchema,
    currency: z.string(),
    capturedAmount: z.number(),
    refundedAmount: z.number(),
  });

export const refundPaymentResponseSchema: z.ZodType<RefundPaymentResponse> =
  z.object({
    id: z.string(),
    status: paymentStatusSchema,
    currency: z.string(),
    capturedAmount: z.number(),
    refundedAmount: z.number(),
  });

export const cancelPaymentResponseSchema: z.ZodType<CancelPaymentResponse> =
  z.object({
    id: z.string(),
    status: paymentStatusSchema,
  });

export const paymentSnapshotSchema: z.ZodType<PaymentSnapshot> = z.object({
  id: z.string(),
  status: paymentStatusSchema,
  currency: z.string(),
  amountAuthorized: z.number(),
  capturedAmount: z.number(),
  refundedAmount: z.number(),
  providerRef: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * pay-core's error envelope (`{"error": {code, message, details?}}`) — see
 * `error-mapper.ts`. Cast, not a direct `z.ZodType<PayCoreErrorEnvelope>`
 * assignment like the schemas above: zod v3 infers an optional field's
 * output type as `T | undefined`, which this project's
 * `exactOptionalPropertyTypes` rejects against `details?: T` (no explicit
 * `| undefined`) even though the two are runtime-equivalent (zod omits the
 * key entirely when the input lacks it, it never sets it to `undefined`).
 */
export const errorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
}) as z.ZodType<PayCoreErrorEnvelope>;
