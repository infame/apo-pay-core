import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LedgerAccount } from "../../../domain/account.js";
import { Money } from "../../../domain/money.js";
import { LedgerEntry } from "../../../domain/entry.js";
import { InvalidLedgerEntryError } from "../../../domain/errors.js";
import type { LedgerEntryRow } from "./schema.js";
import { entryToRow, parseBalanceAmount, rowToEntry } from "./mappers.js";

function makeEntry(
  overrides: Partial<Parameters<typeof LedgerEntry.fromState>[0]> = {},
): LedgerEntry {
  return LedgerEntry.fromState({
    id: randomUUID(),
    operationId: randomUUID(),
    account: LedgerAccount.merchant("acme"),
    direction: "credit",
    amount: Money.of(1500, "USD"),
    paymentId: "pay_1",
    entryType: "capture",
    reversesOperationId: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  });
}

describe("entryToRow", () => {
  it("splits Money into amount+currency and serializes the account", () => {
    const entry = makeEntry();
    const row = entryToRow(entry);
    expect(row.amount).toBe(1500);
    expect(row.currency).toBe("USD");
    expect(row.account).toBe("merchant:acme");
    expect(row.direction).toBe("credit");
    expect(row.entryType).toBe("capture");
    expect(row.reversesOperationId).toBeNull();
  });
});

describe("rowToEntry(entryToRow(entry)) round-trip", () => {
  it("preserves all nine LedgerEntryProps fields, including reversesOperationId: null", () => {
    const entry = makeEntry();
    const rehydrated = rowToEntry(entryToRow(entry) as LedgerEntryRow);
    expect(rehydrated.id).toBe(entry.id);
    expect(rehydrated.operationId).toBe(entry.operationId);
    expect(rehydrated.account.equals(entry.account)).toBe(true);
    expect(rehydrated.direction).toBe(entry.direction);
    expect(rehydrated.amount.equals(entry.amount)).toBe(true);
    expect(rehydrated.paymentId).toBe(entry.paymentId);
    expect(rehydrated.entryType).toBe(entry.entryType);
    expect(rehydrated.reversesOperationId).toBeNull();
    expect(rehydrated.createdAt).toEqual(entry.createdAt);
  });

  it("preserves a non-null reversesOperationId", () => {
    const reversedOp = randomUUID();
    const entry = makeEntry({
      entryType: "reversal",
      reversesOperationId: reversedOp,
    });
    const rehydrated = rowToEntry(entryToRow(entry) as LedgerEntryRow);
    expect(rehydrated.reversesOperationId).toBe(reversedOp);
  });
});

describe("rowToEntry validation", () => {
  it("throws InvalidLedgerEntryError on an unexpected direction (does NOT silently produce a debit)", () => {
    const row = entryToRow(makeEntry()) as LedgerEntryRow;
    const corrupted = { ...row, direction: "DEBIT" };
    expect(() => rowToEntry(corrupted)).toThrow(InvalidLedgerEntryError);
  });

  it("throws InvalidLedgerEntryError on an unexpected entryType", () => {
    const row = entryToRow(makeEntry()) as LedgerEntryRow;
    const corrupted = { ...row, entryType: "chargeback" };
    expect(() => rowToEntry(corrupted)).toThrow(InvalidLedgerEntryError);
  });
});

describe("parseBalanceAmount", () => {
  it("parses '0' as a zero balance", () => {
    expect(parseBalanceAmount("0", "USD").equals(Money.zero("USD"))).toBe(true);
  });

  it("parses a negative sum", () => {
    expect(
      parseBalanceAmount("-300", "USD").equals(Money.of(-300, "USD")),
    ).toBe(true);
  });

  it("throws when the sum exceeds Number.MAX_SAFE_INTEGER", () => {
    expect(() => parseBalanceAmount("9007199254740993", "USD")).toThrow();
  });
});
