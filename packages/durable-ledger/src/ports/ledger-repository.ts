import type { LedgerAccount } from "../domain/account.js";
import type { LedgerEntry, PostingGroup } from "../domain/entry.js";
import type { Currency, Money } from "../domain/money.js";
import { LedgerError } from "../domain/errors.js";

export type PostOutcome = "posted" | "already_posted";

export interface PostResult {
  readonly outcome: PostOutcome;
  readonly operationId: string;
  /**
   * On "posted": the group's own entries. On "already_posted": the STORED
   * entries (their id/createdAt are the FIRST call's, not this caller's) —
   * callers must treat these as authoritative, not their own input.
   */
  readonly entries: readonly LedgerEntry[];
}

/**
 * Persistence port for appending `PostingGroup`s to the append-only ledger
 * and reading them back. Mirrors `@apo/pay-core`'s `PaymentRepository` in
 * shape and doc-comment style (`packages/pay-core/src/ports/payment-repository.ts`).
 */
export interface LedgerRepository {
  /**
   * Appends every entry of `group` in ONE transaction, idempotent on
   * operationId. Re-posting an identical group is a no-op returning the
   * stored entries. Re-posting a DIFFERENT group under the same operationId
   * throws `PostingConflictError` and writes nothing.
   */
  post(group: PostingGroup): Promise<PostResult>;

  /** All entries of one logical operation, ordered by (account, direction). Empty if unposted. */
  findByOperationId(operationId: string): Promise<readonly LedgerEntry[]>;

  /** Every entry for one pay-core payment across operations, ordered by (createdAt, id). */
  findByPaymentId(paymentId: string): Promise<readonly LedgerEntry[]>;

  /** The journal for one account in one currency, ordered by (createdAt, id). */
  findByAccount(
    account: LedgerAccount,
    currency: Currency,
  ): Promise<readonly LedgerEntry[]>;

  /**
   * SUM(credit) - SUM(debit) for one (account, currency), computed in SQL.
   * Contractually identical to `balanceOf(await findByAccount(a,c), a, c)`;
   * `balances.ts` is the specification, this is the pushed-down
   * implementation. Returns `Money.zero(currency)` for an account with no
   * entries.
   */
  getBalance(account: LedgerAccount, currency: Currency): Promise<Money>;
}

/** Same operationId, different entries — a caller bug (key logic changed under a stable key). */
export class PostingConflictError extends LedgerError {
  readonly code = "posting_conflict";
  constructor(
    readonly operationId: string,
    readonly attemptedFingerprint: string,
    readonly storedFingerprint: string,
  ) {
    super(
      `Operation "${operationId}" was already posted with different entries: attempted ${attemptedFingerprint}, stored ${storedFingerprint}`,
    );
  }
}
