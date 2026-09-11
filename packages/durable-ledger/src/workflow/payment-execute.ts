import type { Inngest } from "inngest";
import { NonRetriableError } from "inngest";
import type { PayCoreClient } from "../ports/pay-core-client.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";
import type { DecideRetryOptions } from "./retry-policy.js";
import { resolveRetryPolicy } from "./retry-policy.js";
import { PostingGroup } from "../domain/entry.js";
import { Money } from "../domain/money.js";
import { paymentExecuteRequested } from "./events.js";
import { stepIdempotencyKey } from "./idempotency-key.js";
import { stepOperationId } from "./operation-id.js";
import { rethrowForInngest, inngestRetriesFor } from "./inngest-errors.js";

export interface PaymentExecuteDeps {
  readonly inngest: Inngest;
  readonly payCore: PayCoreClient;
  readonly ledger: LedgerRepository;
  readonly retry?: DecideRetryOptions;
}

/**
 * JSON-safe by construction — step.run/function output is `Jsonify`'d by
 * Inngest (a returned `Date` becomes a string, etc.), so every field here
 * must already be a JSON-primitive shape.
 */
export interface PaymentExecuteResult {
  readonly paymentId: string;
  readonly status: string;
  readonly currency: string;
  readonly capturedAmount: number;
  readonly ledgerOperationId: string;
  readonly ledgerOutcome: "posted" | "already_posted";
}

export const PAYMENT_EXECUTE_FUNCTION_ID = "payment-execute";
export const PAYMENT_EXECUTE_STEPS = [
  "authorize",
  "capture",
  "post-ledger",
] as const;

/**
 * The happy-path `payment.execute` workflow (spec §4.2, step 6 of §13's
 * implementation order): authorize -> capture -> post a `forCapture` ledger
 * entry, each step idempotency-keyed on `(runId, stepName)` so a crash
 * between steps resumes from the unfinished one instead of double-charging.
 * No compensation/saga logic here — a terminal failure or exhausted retries
 * fails the Inngest function cleanly via `NonRetriableError`; unwinding what
 * already succeeded is step 7's job.
 *
 * Deps come in as a plain object rather than being constructed inside this
 * function so tests can pass `FakePayCoreClient`/`InMemoryLedgerRepository`
 * (`./fake-pay-core-client.js`, `../adapters/memory/in-memory-ledger-repository.js`)
 * without any I/O.
 */
export function createPaymentExecuteFunction(deps: PaymentExecuteDeps) {
  const policy = resolveRetryPolicy(deps.retry?.policy);

  return deps.inngest.createFunction(
    {
      id: PAYMENT_EXECUTE_FUNCTION_ID,
      name: "payment.execute",
      retries: inngestRetriesFor(policy),
      triggers: [{ event: paymentExecuteRequested }],
    },
    async ({ event, step, runId, attempt }) => {
      const { amount, currency, paymentMethodToken, merchantId } = event.data;

      const authorized = await step.run("authorize", async () => {
        try {
          return await deps.payCore.createPayment(
            { amount, currency, paymentMethodToken },
            { idempotencyKey: stepIdempotencyKey(runId, "authorize") },
          );
        } catch (error) {
          rethrowForInngest("authorize", error, attempt + 1, deps.retry);
        }
      });

      if (authorized.status !== "authorized") {
        // The 201-with-status:"failed" case (pay-core README's documented
        // gotcha, mirrored in this package's own README under "Talking to
        // pay-core"). This is a clean terminal failure, NOT a place to build
        // compensation — there is nothing to compensate, authorize never
        // succeeded. Step 7 may want to observe this outcome; this step does
        // not build that, and `capturePayment` must never be called here.
        throw new NonRetriableError(
          `Payment ${authorized.id} failed to authorize: status=${authorized.status}`,
        );
      }

      const captured = await step.run("capture", async () => {
        try {
          return await deps.payCore.capturePayment(
            { paymentId: authorized.id },
            { idempotencyKey: stepIdempotencyKey(runId, "capture") },
          );
        } catch (error) {
          rethrowForInngest("capture", error, attempt + 1, deps.retry);
        }
      });

      const ledgerResult = await step.run("post-ledger", async () => {
        const operationId = stepOperationId(runId, "post-ledger");
        try {
          const group = PostingGroup.forCapture({
            operationId,
            paymentId: captured.id,
            merchantId,
            amount: Money.of(captured.capturedAmount, captured.currency),
          });
          const result = await deps.ledger.post(group);
          return { operationId, outcome: result.outcome };
        } catch (error) {
          rethrowForInngest("post-ledger", error, attempt + 1, deps.retry);
        }
      });

      return {
        paymentId: captured.id,
        status: captured.status,
        currency: captured.currency,
        capturedAmount: captured.capturedAmount,
        ledgerOperationId: ledgerResult.operationId,
        ledgerOutcome: ledgerResult.outcome,
      } satisfies PaymentExecuteResult;
    },
  );
}
