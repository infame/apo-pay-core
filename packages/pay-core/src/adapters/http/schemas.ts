import { z } from "zod";
import { CreatePaymentCommand } from "../../app/create-payment.js";
import { CapturePaymentCommand } from "../../app/capture-payment.js";
import { RefundPaymentCommand } from "../../app/refund-payment.js";

export const PaymentIdParam = z.string().uuid();

/**
 * Request-body schemas, derived from the use-case command schemas via
 * `.omit()` rather than hand-written parallel field lists, so the HTTP layer
 * can't drift from what the use-case actually validates. `idempotencyKey`
 * comes from the `Idempotency-Key` header (see `request.ts`), not the body;
 * path-only fields (`paymentId`) come from the URL. Unknown keys are left
 * stripped (Zod's default), not rejected with `.strict()` — clients sending
 * extra fields stay forward-compatible.
 */
export const CreatePaymentBody = CreatePaymentCommand.omit({
  idempotencyKey: true,
});
export type CreatePaymentBody = z.infer<typeof CreatePaymentBody>;

export const CapturePaymentBody = CapturePaymentCommand.omit({
  paymentId: true,
  idempotencyKey: true,
});
export type CapturePaymentBody = z.infer<typeof CapturePaymentBody>;

export const RefundPaymentBody = RefundPaymentCommand.omit({
  paymentId: true,
  idempotencyKey: true,
});
export type RefundPaymentBody = z.infer<typeof RefundPaymentBody>;

// Cancel has no body fields — nothing to declare.
