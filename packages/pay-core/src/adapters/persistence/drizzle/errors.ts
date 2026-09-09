/**
 * Infrastructure errors raised by the Postgres adapters. These are
 * deliberately *not* `DomainError` subclasses (`src/domain/errors.ts`):
 * `DomainError` models payment-state invariants the domain itself enforces
 * (illegal transition, amount exceeded, not found). Optimistic-lock and
 * duplicate-idempotency-key conflicts are a property of *this* persistence
 * adapter's concurrency control, not something the domain knows about — a
 * different repository implementation (e.g. in-memory, single-threaded)
 * never raises them. Callers that need to distinguish "domain rejected this"
 * from "storage detected a race" can rely on the class hierarchy for that.
 */

/** Optimistic-lock conflict: `version` no longer matches what was read. */
export class OptimisticLockError extends Error {
  constructor(
    readonly paymentId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Optimistic lock conflict on payment "${paymentId}": expected version ${expectedVersion}`,
    );
    this.name = "OptimisticLockError";
  }
}

/** A second `(key, operation)` pair was inserted after the first won the race. */
export class DuplicateIdempotencyKeyError extends Error {
  constructor(
    readonly key: string,
    readonly operation: string,
  ) {
    super(
      `Idempotency key "${key}" already exists for operation "${operation}"`,
    );
    this.name = "DuplicateIdempotencyKeyError";
  }
}

/** Postgres error shape carrying a SQLSTATE `code` (e.g. `23505` = unique_violation). */
interface PgErrorLike {
  readonly code: string;
}

function hasPgErrorCode(err: unknown): err is PgErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof err.code === "string"
  );
}

/**
 * drizzle-orm (0.45.x, `node-postgres` driver) wraps the raw `pg` driver
 * error in its own `DrizzleQueryError` (carrying `query`/`params`), with the
 * original error — the one that actually has `.code`/`.constraint` — on
 * `.cause`. Unwrap one level so `isUniqueViolation` sees the real SQLSTATE.
 */
function pgErrorOf(err: unknown): PgErrorLike | undefined {
  if (hasPgErrorCode(err)) {
    return err;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "cause" in err &&
    hasPgErrorCode(err.cause)
  ) {
    return err.cause;
  }
  return undefined;
}

/**
 * Narrow `unknown` to "this is a Postgres unique-violation error", optionally
 * scoped to a specific constraint name (when the driver surfaces `constraint`).
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pgErr = pgErrorOf(err);
  if (!pgErr || pgErr.code !== "23505") {
    return false;
  }
  if (constraint === undefined) {
    return true;
  }
  return "constraint" in pgErr && pgErr.constraint === constraint;
}
