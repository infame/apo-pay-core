import { InvalidAccountError } from "./errors.js";

export type AccountKind = "customer" | "merchant" | "acquirer_clearing";

const SUBJECT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Serialized form matches the future DB `account` text column: "merchant:42",
 * "acquirer_clearing" (docs/todo/02-durable-ledger.md §3.2, §7).
 */
export class LedgerAccount {
  private constructor(
    readonly kind: AccountKind,
    readonly subject: string | null,
  ) {}

  private static withSubject(
    kind: AccountKind,
    subject: string,
  ): LedgerAccount {
    if (!SUBJECT.test(subject)) {
      throw new InvalidAccountError(
        `Invalid subject for account kind "${kind}": ${JSON.stringify(subject)}`,
      );
    }
    return new LedgerAccount(kind, subject);
  }

  static customer(id: string): LedgerAccount {
    return LedgerAccount.withSubject("customer", id);
  }

  static merchant(id: string): LedgerAccount {
    return LedgerAccount.withSubject("merchant", id);
  }

  static acquirerClearing(): LedgerAccount {
    return new LedgerAccount("acquirer_clearing", null);
  }

  /** Inverse of toString(); a future Postgres row mapper will use this. */
  static parse(raw: string): LedgerAccount {
    if (raw === "acquirer_clearing") {
      return LedgerAccount.acquirerClearing();
    }
    const separatorIndex = raw.indexOf(":");
    if (separatorIndex === -1) {
      throw new InvalidAccountError(
        `Cannot parse account: ${JSON.stringify(raw)}`,
      );
    }
    const kind = raw.slice(0, separatorIndex);
    const subject = raw.slice(separatorIndex + 1);
    if (kind === "customer") {
      return LedgerAccount.customer(subject);
    }
    if (kind === "merchant") {
      return LedgerAccount.merchant(subject);
    }
    throw new InvalidAccountError(
      `Unknown account kind: ${JSON.stringify(kind)}`,
    );
  }

  equals(other: LedgerAccount): boolean {
    return this.kind === other.kind && this.subject === other.subject;
  }

  toString(): string {
    return this.subject === null ? this.kind : `${this.kind}:${this.subject}`;
  }

  toJSON(): string {
    return this.toString();
  }
}
