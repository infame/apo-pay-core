import { createHash } from "node:crypto";

/**
 * Deterministic RFC-9562 v8 UUID from (runId, stepName) — NOT the same value
 * as `stepIdempotencyKey(runId, stepName)` (`./idempotency-key.js`).
 * `stepIdempotencyKey` returns a 64-char sha256 hex string sent to pay-core
 * as `Idempotency-Key`; `PostingGroup.create` (`../domain/entry.js`)
 * requires its `operationId` to be UUID-shaped (`assertUUID`'s regex), so a
 * second, UUID-shaped derivation is needed for the ledger side. Both derive
 * from the same underlying `${runId}:${stepName}` input (same shape as
 * `stepIdempotencyKey`, for consistency) so a retried step reproduces the
 * same value on both sides, but the two are computed differently and are NOT
 * interchangeable — do not substitute one for the other.
 *
 * Construction: sha256 the input, take the first 16 bytes of the digest, set
 * byte 6's high nibble to `8` (version 8, RFC 9562 §5.8 — a
 * vendor/purpose-specific layout, which this is: "sha256 of a workflow
 * step", not one of the standard name/random/time layouts) and byte 8's top
 * two bits to `10` (the RFC-4122 variant), then format as the standard
 * hyphenated 8-4-4-4-12 lowercase hex UUID string.
 *
 * Throws a plain `Error`, not a `LedgerError` subclass — same reasoning as
 * `stepIdempotencyKey`: this validates an input to a workflow-layer helper,
 * not a ledger domain invariant.
 */
export function stepOperationId(runId: string, stepName: string): string {
  if (runId.trim() === "") {
    throw new Error("stepOperationId: runId must not be empty");
  }
  if (stepName.trim() === "") {
    throw new Error("stepOperationId: stepName must not be empty");
  }

  const digest = createHash("sha256").update(`${runId}:${stepName}`).digest();
  const bytes = digest.subarray(0, 16);

  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
