import { and, asc, eq, sql } from "drizzle-orm";
import type { LedgerAccount } from "../../../domain/account.js";
import type { LedgerEntry, PostingGroup } from "../../../domain/entry.js";
import type { Currency, Money } from "../../../domain/money.js";
import { fingerprintOf } from "../../../domain/posting-fingerprint.js";
import {
  PostingConflictError,
  type LedgerRepository,
  type PostResult,
} from "../../../ports/ledger-repository.js";
import { ledgerEntries } from "./schema.js";
import type { Database } from "./db.js";
import { DuplicatePostingError, isUniqueViolation } from "./errors.js";
import { entryToRow, parseBalanceAmount, rowToEntry } from "./mappers.js";

/** 0x4C454447 = 'LEDG', arbitrary fixed advisory-lock namespace for this repo. */
const LOCK_NAMESPACE = 1279350343;

type LedgerTx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | LedgerTx;

/**
 * Postgres/Drizzle implementation of `LedgerRepository`.
 *
 * Concurrency & idempotency: `post()` takes a Postgres session-scoped
 * advisory lock (`pg_advisory_xact_lock`, keyed by `hashtext(operationId)`)
 * before reading or writing anything for that operation, all inside one
 * transaction. This is stronger than relying on the
 * `(operation_id, account, direction)` unique index alone: two concurrent
 * `post()` calls for the same operationId but *disjoint* accounts (e.g. one
 * group posts to `merchant:a`, a conflicting one to `merchant:b`) share no
 * row the unique index could collide on, so without the lock both could
 * insert and the ledger would end up with two different postings under one
 * operationId. The lock serializes every `post()` for a given operationId
 * so the second caller always sees the first caller's rows already
 * committed before it decides whether to no-op or insert.
 *
 * `DuplicatePostingError` (from a caught unique-violation) is therefore a
 * backstop, not the primary mechanism — see its doc comment in `errors.ts`.
 */
export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly db: Database) {}

  async post(group: PostingGroup): Promise<PostResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${group.operationId}))`,
      );

      const existing = await this.#selectByOperationId(tx, group.operationId);
      if (existing.length > 0) {
        const attempted = fingerprintOf(group.entries);
        const stored = fingerprintOf(existing);
        if (attempted !== stored) {
          throw new PostingConflictError(group.operationId, attempted, stored);
        }
        return {
          outcome: "already_posted" as const,
          operationId: group.operationId,
          entries: existing,
        };
      }

      try {
        await tx.insert(ledgerEntries).values(group.entries.map(entryToRow));
      } catch (err) {
        if (
          isUniqueViolation(
            err,
            "ledger_entries_operation_account_direction_uq",
          )
        ) {
          throw new DuplicatePostingError(group.operationId, { cause: err });
        }
        throw err;
      }

      // The insert wrote an explicit `createdAt` from the domain, never the
      // column default, so `group.entries` is already identical to what's
      // stored — no need to re-select.
      return {
        outcome: "posted" as const,
        operationId: group.operationId,
        entries: group.entries,
      };
    });
  }

  async findByOperationId(
    operationId: string,
  ): Promise<readonly LedgerEntry[]> {
    return this.#selectByOperationId(this.db, operationId);
  }

  async findByPaymentId(paymentId: string): Promise<readonly LedgerEntry[]> {
    const rows = await this.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId))
      .orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.id));
    return rows.map(rowToEntry);
  }

  async findByAccount(
    account: LedgerAccount,
    currency: Currency,
  ): Promise<readonly LedgerEntry[]> {
    const rows = await this.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.account, account.toString()),
          eq(ledgerEntries.currency, currency),
        ),
      )
      .orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.id));
    return rows.map(rowToEntry);
  }

  async getBalance(account: LedgerAccount, currency: Currency): Promise<Money> {
    const rows = await this.db
      .select({
        balance: sql<string>`COALESCE(SUM(CASE WHEN ${ledgerEntries.direction} = 'credit' THEN ${ledgerEntries.amount} ELSE -${ledgerEntries.amount} END), 0)`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.account, account.toString()),
          eq(ledgerEntries.currency, currency),
        ),
      );
    const raw = rows[0]?.balance ?? "0";
    return parseBalanceAmount(raw, currency);
  }

  async #selectByOperationId(
    executor: Executor,
    operationId: string,
  ): Promise<LedgerEntry[]> {
    const rows = await executor
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.operationId, operationId))
      .orderBy(asc(ledgerEntries.account), asc(ledgerEntries.direction));
    return rows.map(rowToEntry);
  }
}
