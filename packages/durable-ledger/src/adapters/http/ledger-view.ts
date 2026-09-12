import type { LedgerEntry } from "../../domain/entry.js";

/**
 * JSON-safe view of a `LedgerEntry` for the HTTP layer. `LedgerEntry` itself
 * has no `toJSON()` (unlike `Money`/`LedgerAccount`), so every field is
 * mapped explicitly here rather than relying on `c.json()`'s default
 * serialization to do the right thing.
 */
export interface LedgerEntryView {
  readonly id: string;
  readonly operationId: string;
  readonly account: string;
  readonly direction: string;
  readonly amount: { readonly amount: number; readonly currency: string };
  readonly paymentId: string;
  readonly entryType: string;
  readonly reversesOperationId: string | null;
  readonly createdAt: string;
}

export function toLedgerEntryView(entry: LedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    operationId: entry.operationId,
    account: entry.account.toString(),
    direction: entry.direction,
    amount: entry.amount.toJSON(),
    paymentId: entry.paymentId,
    entryType: entry.entryType,
    reversesOperationId: entry.reversesOperationId,
    createdAt: entry.createdAt.toISOString(),
  };
}
