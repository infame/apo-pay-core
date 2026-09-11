import type { LedgerAccount } from "../../domain/account.js";
import type { LedgerEntry, PostingGroup } from "../../domain/entry.js";
import type { Currency, Money } from "../../domain/money.js";
import { balanceOf } from "../../domain/balances.js";
import { fingerprintOf } from "../../domain/posting-fingerprint.js";
import {
  PostingConflictError,
  type LedgerRepository,
  type PostResult,
} from "../../ports/ledger-repository.js";

/**
 * In-memory `LedgerRepository` for tests and local demos — mirrors
 * `@apo/pay-core`'s `InMemoryPaymentRepository`
 * (`packages/pay-core/src/adapters/memory/in-memory-payment-repository.ts`)
 * in spirit: a genuine second implementation of the port's contract, not a
 * hand-rolled approximation, so it reuses the exact same domain-level
 * building blocks (`fingerprintOf`, `balanceOf`) that `PgLedgerRepository`
 * (`../persistence/drizzle/pg-ledger-repository.js`) reduces to SQL.
 *
 * Concurrency: `PgLedgerRepository.post()` needs a real advisory lock
 * because two concurrent Postgres transactions could otherwise both decide
 * "not yet posted" and both insert. This adapter's `post()` runs entirely
 * synchronously between its first read and its write — JavaScript's
 * single-threaded execution model means no other `post()` call can
 * interleave inside that window, so no explicit lock is needed here to get
 * the same idempotent/conflict-detecting behavior.
 */
export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly byOperationId = new Map<string, readonly LedgerEntry[]>();
  private readonly entries: LedgerEntry[] = [];

  async post(group: PostingGroup): Promise<PostResult> {
    const existing = this.byOperationId.get(group.operationId);
    if (existing !== undefined) {
      const attempted = fingerprintOf(group.entries);
      const stored = fingerprintOf(existing);
      if (attempted !== stored) {
        throw new PostingConflictError(group.operationId, attempted, stored);
      }
      return {
        outcome: "already_posted",
        operationId: group.operationId,
        entries: existing,
      };
    }

    this.byOperationId.set(group.operationId, group.entries);
    this.entries.push(...group.entries);

    return {
      outcome: "posted",
      operationId: group.operationId,
      entries: group.entries,
    };
  }

  async findByOperationId(
    operationId: string,
  ): Promise<readonly LedgerEntry[]> {
    const stored = this.byOperationId.get(operationId);
    if (stored === undefined) {
      return [];
    }
    return [...stored].sort(compareByAccountThenDirection);
  }

  async findByPaymentId(paymentId: string): Promise<readonly LedgerEntry[]> {
    return this.entries
      .filter((entry) => entry.paymentId === paymentId)
      .sort(compareByCreatedAtThenId);
  }

  async findByAccount(
    account: LedgerAccount,
    currency: Currency,
  ): Promise<readonly LedgerEntry[]> {
    return this.entries
      .filter(
        (entry) =>
          entry.account.equals(account) && entry.amount.currency === currency,
      )
      .sort(compareByCreatedAtThenId);
  }

  async getBalance(account: LedgerAccount, currency: Currency): Promise<Money> {
    return balanceOf(
      await this.findByAccount(account, currency),
      account,
      currency,
    );
  }
}

function compareByAccountThenDirection(a: LedgerEntry, b: LedgerEntry): number {
  const accountCompare = a.account
    .toString()
    .localeCompare(b.account.toString());
  if (accountCompare !== 0) {
    return accountCompare;
  }
  return a.direction.localeCompare(b.direction);
}

function compareByCreatedAtThenId(a: LedgerEntry, b: LedgerEntry): number {
  const createdAtCompare = a.createdAt.getTime() - b.createdAt.getTime();
  if (createdAtCompare !== 0) {
    return createdAtCompare;
  }
  return a.id.localeCompare(b.id);
}
