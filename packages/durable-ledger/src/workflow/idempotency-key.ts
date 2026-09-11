import { createHash } from "node:crypto";

/**
 * Idempotency-Key = sha256(runId + ":" + stepName), hex — spec §2.
 * Deterministic: an Inngest step re-run produces the SAME key, so pay-core
 * replays its stored snapshot instead of performing a second effect.
 * Lives here, not in the HTTP client: the client only knows "a key string",
 * nothing about runId/stepName/Inngest (which doesn't exist in this package yet).
 * Known, accepted collision: sha256("a:b" + ":" + "c") === sha256("a" + ":" + "b:c")
 * — a length-prefixed encoding would remove it but deviate from the spec's
 * literal formula; unreachable in practice with Inngest-generated runIds and
 * literal step names. Pinned by a test, not silently left as a surprise.
 *
 * Throws a plain `Error`, not a `LedgerError` subclass
 * (`src/domain/errors.ts`): this validates an input to a workflow-layer
 * helper before any HTTP call is made, not a ledger domain invariant — the
 * same "wrong error family for this failure" reasoning that keeps
 * `PayCoreClientError` (`src/ports/pay-core-errors.ts`) out of the
 * `LedgerError` hierarchy too.
 */
export function stepIdempotencyKey(runId: string, stepName: string): string {
  if (runId.trim() === "") {
    throw new Error("stepIdempotencyKey: runId must not be empty");
  }
  if (stepName.trim() === "") {
    throw new Error("stepIdempotencyKey: stepName must not be empty");
  }
  return createHash("sha256").update(`${runId}:${stepName}`).digest("hex");
}
