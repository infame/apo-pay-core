/**
 * Pure projections over any `Iterable<LedgerEntry>` — no I/O, no port
 * dependency, so a later Postgres step can feed this an array pulled from a
 * query just as easily as an in-memory array (docs/todo/02-durable-ledger.md
 * §3.4).
 *
 * Sign convention: a balance is `SUM(credit) − SUM(debit)`. After a capture
 * (debit acquirer_clearing, credit merchant), `acquirer_clearing` runs
 * NEGATIVE — it's a clearing/liability account, this is correct, not a bug.
 * See `balances.test.ts` for a named test asserting this so nobody "fixes"
 * the sign later.
 */

import type { LedgerEntry } from "./entry.js";
import type { LedgerAccount } from "./account.js";
import type { Currency } from "./money.js";
import { Money } from "./money.js";
import { LedgerImbalanceError } from "./errors.js";

/** §3.4: balance = SUM(credit) − SUM(debit), for one account in one currency. */
export function balanceOf(
  entries: Iterable<LedgerEntry>,
  account: LedgerAccount,
  currency: Currency,
): Money {
  let balance = Money.zero(currency);
  for (const entry of entries) {
    if (entry.account.equals(account) && entry.amount.currency === currency) {
      balance = balance.add(entry.signedAmount());
    }
  }
  return balance;
}

/** Every (account, currency) pair that appears in `entries`, keyed as `${account}|${currency}`. */
export function balanceSheet(
  entries: Iterable<LedgerEntry>,
): ReadonlyMap<string, Money> {
  const sheet = new Map<string, Money>();
  for (const entry of entries) {
    const key = `${entry.account.toString()}|${entry.amount.currency}`;
    const current = sheet.get(key) ?? Money.zero(entry.amount.currency);
    sheet.set(key, current.add(entry.signedAmount()));
  }
  return sheet;
}

/** Per-currency residual (sum of ALL account balances in that currency). Every value must be zero for a healthy ledger. */
export function residuals(
  entries: Iterable<LedgerEntry>,
): ReadonlyMap<Currency, Money> {
  const totals = new Map<Currency, Money>();
  for (const entry of entries) {
    const currency = entry.amount.currency;
    const current = totals.get(currency) ?? Money.zero(currency);
    totals.set(currency, current.add(entry.signedAmount()));
  }
  return totals;
}

export function isBalanced(entries: Iterable<LedgerEntry>): boolean {
  for (const residual of residuals(entries).values()) {
    if (!residual.isZero()) {
      return false;
    }
  }
  return true;
}

/** Throws LedgerImbalanceError(residuals) if any residual is non-zero. This will back a future GET /ledger/integrity endpoint. */
export function assertZeroSum(entries: Iterable<LedgerEntry>): void {
  const allResiduals = residuals(entries);
  const nonZero = new Map<Currency, Money>();
  for (const [currency, residual] of allResiduals) {
    if (!residual.isZero()) {
      nonZero.set(currency, residual);
    }
  }
  if (nonZero.size > 0) {
    throw new LedgerImbalanceError(nonZero);
  }
}
