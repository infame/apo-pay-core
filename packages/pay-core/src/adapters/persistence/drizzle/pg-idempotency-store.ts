import { and, eq } from "drizzle-orm";
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from "../../../ports/idempotency-store.js";
import { idempotencyKeys } from "./schema.js";
import { DuplicateIdempotencyKeyError, isUniqueViolation } from "./errors.js";
import type { TransactionScope } from "./transaction-scope.js";

/**
 * Postgres/Drizzle implementation of `IdempotencyStore`, scoped to one
 * operation (`"create_payment"`, `"capture_payment"`, …) per instance — the
 * composition root constructs one per use-case so a key reused across
 * different operations never collides (`PRIMARY KEY (key, operation)`).
 *
 * `save` does a plain `INSERT`, no `onConflictDoNothing`: the primary key
 * violation *is* the "exactly once" mechanism, not a fallback path. A
 * concurrent duplicate is rethrown as `DuplicateIdempotencyKeyError` instead
 * of leaking the raw pg error, so callers (the composition root's
 * idempotency-race handling) can catch a stable, typed error.
 *
 * Response snapshots are serialized with plain `JSON.stringify`/jsonb — no
 * custom codec. All three `*Result` types (`CreatePaymentResult`, etc.) are
 * flat objects of primitives (string/number/boolean/null), so there is
 * nothing here that doesn't round-trip through JSON (no `Date`, no `Money`,
 * no `undefined`). If a future result type needs one of those, this is the
 * seam that would need a codec.
 */
export class PgIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly scope: TransactionScope,
    private readonly operation: string,
  ) {}

  async find(key: string): Promise<IdempotencyRecord | null> {
    const db = this.scope.current();
    const rows = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.operation, this.operation),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      key: row.key,
      requestFingerprint: row.requestHash,
      response: row.responseSnapshot,
      createdAt: row.createdAt,
    };
  }

  async save(record: IdempotencyRecord): Promise<void> {
    const db = await this.scope.beginIfNeeded();
    try {
      await db.insert(idempotencyKeys).values({
        key: record.key,
        operation: this.operation,
        requestHash: record.requestFingerprint,
        responseSnapshot: record.response,
        createdAt: record.createdAt,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DuplicateIdempotencyKeyError(record.key, this.operation);
      }
      throw err;
    }
  }
}
