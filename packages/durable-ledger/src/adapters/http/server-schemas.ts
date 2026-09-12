import { z } from "zod";
import { paymentExecuteRequestedSchema } from "../../workflow/events.js";

/** Re-exported, not redeclared — the trigger route's body must never drift from the event schema the workflow itself validates against. */
export const StartPaymentWorkflowBody = paymentExecuteRequestedSchema;
export type StartPaymentWorkflowBody = z.infer<typeof StartPaymentWorkflowBody>;

/** Inngest event ids are ULIDs — 26 Crockford-base32 characters. */
export const EventIdParam = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i, "Invalid event id");

export const LedgerEntriesQuery = z
  .object({
    paymentId: z.string().min(1).optional(),
    operationId: z.string().uuid().optional(),
  })
  .refine(
    (q) => (q.paymentId === undefined) !== (q.operationId === undefined),
    {
      message: "Provide exactly one of paymentId or operationId",
    },
  );
export type LedgerEntriesQuery = z.infer<typeof LedgerEntriesQuery>;

export const CurrencyQuery = z
  .string()
  .regex(/^[A-Z]{3}$/, "Invalid ISO-4217 currency");
