import { LedgerAccount } from "../../../domain/account.js";
import type { Currency } from "../../../domain/money.js";
import { Money } from "../../../domain/money.js";
import { InvalidLedgerEntryError } from "../../../domain/errors.js";
import type { Direction, EntryType } from "../../../domain/entry.js";
import { LedgerEntry } from "../../../domain/entry.js";
import type { LedgerEntryRow, NewLedgerEntryRow } from "./schema.js";

const DIRECTIONS: readonly Direction[] = ["debit", "credit"];
const ENTRY_TYPES: readonly EntryType[] = ["capture", "refund", "reversal"];

function assertDirection(value: string): Direction {
  if (!DIRECTIONS.includes(value as Direction)) {
    throw new InvalidLedgerEntryError(
      `Invalid direction read back from storage: ${JSON.stringify(value)}`,
    );
  }
  return value as Direction;
}

function assertEntryType(value: string): EntryType {
  if (!ENTRY_TYPES.includes(value as EntryType)) {
    throw new InvalidLedgerEntryError(
      `Invalid entry_type read back from storage: ${JSON.stringify(value)}`,
    );
  }
  return value as EntryType;
}

/** `LedgerEntry` -> `ledger_entries` insert row, splitting `Money` into `amount`+`currency`. */
export function entryToRow(entry: LedgerEntry): NewLedgerEntryRow {
  const state = entry.toState();
  return {
    id: state.id,
    operationId: state.operationId,
    account: state.account.toString(),
    direction: state.direction,
    amount: state.amount.amount,
    currency: state.amount.currency,
    paymentId: state.paymentId,
    entryType: state.entryType,
    reversesOperationId: state.reversesOperationId,
    createdAt: state.createdAt,
  };
}

/**
 * `ledger_entries` row -> `LedgerEntry`. Unlike the inline helpers in
 * `ledger-entries-schema.integration.test.ts` (which deliberately probe
 * malformed rows the DB's CHECK constraints reject), this mapper never
 * blind-casts `row.direction`/`row.entryType` — a corrupt value read back
 * from storage throws `InvalidLedgerEntryError` instead of silently
 * miscasting into a debit/capture and corrupting a balance with no error.
 */
export function rowToEntry(row: LedgerEntryRow): LedgerEntry {
  return LedgerEntry.fromState({
    id: row.id,
    operationId: row.operationId,
    account: LedgerAccount.parse(row.account),
    direction: assertDirection(row.direction),
    amount: Money.of(row.amount, row.currency),
    paymentId: row.paymentId,
    entryType: assertEntryType(row.entryType),
    reversesOperationId: row.reversesOperationId,
    createdAt: row.createdAt,
  });
}

/**
 * Postgres `SUM(bigint)` returns `numeric`, which the `pg` driver returns as
 * a string (it would lose precision as a JS `number` for large sums). Parse
 * through `BigInt` and reject anything outside `Number.MAX_SAFE_INTEGER`
 * range rather than silently rounding — `Money.amount` is a plain `number`,
 * so there's no lossless way to represent a bigger sum here.
 */
export function parseBalanceAmount(raw: string, currency: Currency): Money {
  const amount = BigInt(raw);
  if (
    amount > BigInt(Number.MAX_SAFE_INTEGER) ||
    amount < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new Error(
      `Balance amount ${raw} is outside the safe integer range representable by Money`,
    );
  }
  return Money.of(Number(amount), currency);
}
