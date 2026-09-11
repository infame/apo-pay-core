import { randomUUID } from "node:crypto";
import type { Currency } from "./money.js";
import { Money } from "./money.js";
import { LedgerAccount } from "./account.js";
import {
  CurrencyMismatchError,
  InvalidLedgerEntryError,
  UnbalancedPostingError,
} from "./errors.js";

export type Direction = "debit" | "credit";
export type EntryType = "capture" | "refund" | "reversal";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUUID(value: string, label: string): void {
  if (!UUID.test(value)) {
    throw new InvalidLedgerEntryError(
      `Invalid ${label}: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Fields are deliberately 1:1 with the future Postgres `ledger_entries`
 * columns (docs/todo/02-durable-ledger.md §7) so a later step's schema is a
 * mechanical transcription, not a redesign.
 */
export interface LedgerEntryProps {
  readonly id: string; // uuid, row identity
  readonly operationId: string; // uuid, groups one logical operation
  readonly account: LedgerAccount;
  readonly direction: Direction;
  readonly amount: Money; // strictly positive; sign lives in `direction`
  readonly paymentId: string; // opaque pay-core payment id
  readonly entryType: EntryType;
  readonly reversesOperationId: string | null;
  readonly createdAt: Date;
}

export class LedgerEntry {
  private constructor(private readonly props: LedgerEntryProps) {}

  /** Rehydrate as-is, no re-validation (e.g. a row read back from storage). */
  static fromState(props: LedgerEntryProps): LedgerEntry {
    return new LedgerEntry({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get operationId(): string {
    return this.props.operationId;
  }
  get account(): LedgerAccount {
    return this.props.account;
  }
  get direction(): Direction {
    return this.props.direction;
  }
  get amount(): Money {
    return this.props.amount;
  }
  get paymentId(): string {
    return this.props.paymentId;
  }
  get entryType(): EntryType {
    return this.props.entryType;
  }
  get reversesOperationId(): string | null {
    return this.props.reversesOperationId;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  toState(): LedgerEntryProps {
    return { ...this.props };
  }

  /** Signed contribution to a balance: +amount for credit, -amount for debit. */
  signedAmount(): Money {
    return this.props.direction === "credit"
      ? this.props.amount
      : this.props.amount.negate();
  }
}

/**
 * What a caller hands to PostingGroup; the group supplies the shared fields
 * (operationId, paymentId, entryType, createdAt, ids).
 */
export interface EntryDraft {
  readonly account: LedgerAccount;
  readonly direction: Direction;
  readonly amount: Money;
}

export class PostingGroup {
  private constructor(
    readonly operationId: string,
    readonly entries: readonly LedgerEntry[],
  ) {}

  /**
   * The ONLY way to construct a valid set of entries. Throws unless every
   * invariant below holds. `operationId` is REQUIRED and must never be
   * generated internally (e.g. via randomUUID()) — a caller (a durable
   * workflow step, later) supplies it deterministically so a retried step
   * reuses the same id instead of double-posting a second balanced group
   * that the zero-sum invariant would not catch.
   */
  static create(params: {
    operationId: string;
    paymentId: string;
    entryType: EntryType;
    entries: readonly EntryDraft[];
    reversesOperationId?: string;
    now?: Date;
  }): PostingGroup {
    const {
      operationId,
      paymentId,
      entryType,
      entries,
      reversesOperationId,
      now,
    } = params;

    assertUUID(operationId, "operationId");
    if (reversesOperationId !== undefined) {
      assertUUID(reversesOperationId, "reversesOperationId");
    }

    // 1. Minimum two entries (§3.1).
    if (entries.length < 2) {
      throw new InvalidLedgerEntryError(
        `A posting group needs at least two entries, got ${entries.length}`,
      );
    }

    // 2. At least one debit and one credit — the actual statement of what
    // double-entry means, not implied by the balance check alone.
    const hasDebit = entries.some((entry) => entry.direction === "debit");
    const hasCredit = entries.some((entry) => entry.direction === "credit");
    if (!hasDebit || !hasCredit) {
      throw new InvalidLedgerEntryError(
        "A posting group needs at least one debit and one credit entry",
      );
    }

    // 3. Every amount strictly positive; sign lives in `direction`.
    for (const entry of entries) {
      if (!entry.amount.isPositive()) {
        throw new InvalidLedgerEntryError(
          `Entry amount must be positive, got ${entry.amount.toString()}`,
        );
      }
    }

    // 4. Single currency across the group.
    const currency = entries[0]!.amount.currency;
    for (const entry of entries) {
      if (entry.amount.currency !== currency) {
        throw new CurrencyMismatchError(currency, entry.amount.currency);
      }
    }

    // 6. No two entries share the same (account, direction) pair.
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.direction}:${entry.account.toString()}`;
      if (seen.has(key)) {
        throw new InvalidLedgerEntryError(
          `Duplicate (account, direction) pair in posting group: ${key}`,
        );
      }
      seen.add(key);
    }

    // 5. sum(debit) === sum(credit).
    const debitTotal = Money.sum(
      entries
        .filter((entry) => entry.direction === "debit")
        .map((entry) => entry.amount),
      currency,
    );
    const creditTotal = Money.sum(
      entries
        .filter((entry) => entry.direction === "credit")
        .map((entry) => entry.amount),
      currency,
    );
    if (!debitTotal.equals(creditTotal)) {
      throw new UnbalancedPostingError(debitTotal, creditTotal);
    }

    const createdAt = now ?? new Date();
    const ledgerEntries = entries.map((draft) =>
      LedgerEntry.fromState({
        id: randomUUID(),
        operationId,
        account: draft.account,
        direction: draft.direction,
        amount: draft.amount,
        paymentId,
        entryType,
        reversesOperationId: reversesOperationId ?? null,
        createdAt,
      }),
    );

    return new PostingGroup(operationId, ledgerEntries);
  }

  /**
   * §3.3: debit acquirer_clearing, credit merchant:<id>, for the captured
   * amount.
   */
  static forCapture(params: {
    operationId: string;
    paymentId: string;
    merchantId: string;
    amount: Money;
    now?: Date;
  }): PostingGroup {
    return PostingGroup.create({
      operationId: params.operationId,
      paymentId: params.paymentId,
      entryType: "capture",
      ...(params.now !== undefined ? { now: params.now } : {}),
      entries: [
        {
          account: LedgerAccount.acquirerClearing(),
          direction: "debit",
          amount: params.amount,
        },
        {
          account: LedgerAccount.merchant(params.merchantId),
          direction: "credit",
          amount: params.amount,
        },
      ],
    });
  }

  /**
   * §3.3: debit merchant:<id>, credit acquirer_clearing, for the refunded
   * amount.
   */
  static forRefund(params: {
    operationId: string;
    paymentId: string;
    merchantId: string;
    amount: Money;
    now?: Date;
  }): PostingGroup {
    return PostingGroup.create({
      operationId: params.operationId,
      paymentId: params.paymentId,
      entryType: "refund",
      ...(params.now !== undefined ? { now: params.now } : {}),
      entries: [
        {
          account: LedgerAccount.merchant(params.merchantId),
          direction: "debit",
          amount: params.amount,
        },
        {
          account: LedgerAccount.acquirerClearing(),
          direction: "credit",
          amount: params.amount,
        },
      ],
    });
  }

  get currency(): Currency {
    return this.entries[0]!.amount.currency;
  }

  totalDebit(): Money {
    return Money.sum(
      this.entries
        .filter((entry) => entry.direction === "debit")
        .map((entry) => entry.amount),
      this.currency,
    );
  }

  totalCredit(): Money {
    return Money.sum(
      this.entries
        .filter((entry) => entry.direction === "credit")
        .map((entry) => entry.amount),
      this.currency,
    );
  }
}
