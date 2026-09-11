import type { LedgerEntry } from "./entry.js";

/**
 * Canonical, order-independent identity of a set of ledger entries.
 * EXCLUDES `id` and `createdAt`: `PostingGroup.create` mints a fresh
 * `randomUUID()` per entry on every call, so a retried step legitimately
 * rebuilds "the same" group with different row ids — including them here
 * would make every retry look like a conflict.
 *
 * Each entry is reduced to `[account, direction, amount, currency,
 * paymentId, entryType, reversesOperationId]`, individually
 * `JSON.stringify`'d (not the whole array first — per-tuple strings are what
 * let us sort them independently of input order), sorted, then wrapped with
 * a version tag. `JSON.stringify`, not a `|`-joined string, specifically
 * because `paymentId` is opaque pay-core text that could contain any
 * separator character we might otherwise pick.
 */
export function fingerprintOf(entries: Iterable<LedgerEntry>): string {
  const tuples = Array.from(entries, (entry) =>
    JSON.stringify([
      entry.account.toString(),
      entry.direction,
      entry.amount.amount,
      entry.amount.currency,
      entry.paymentId,
      entry.entryType,
      entry.reversesOperationId,
    ]),
  );
  tuples.sort();
  return JSON.stringify(["v1", ...tuples]);
}
