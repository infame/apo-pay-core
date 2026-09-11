/**
 * Infrastructure errors raised by the Postgres adapter. Deliberately *not*
 * `LedgerError` subclasses (`src/domain/errors.ts`): `LedgerError` models
 * invariants the domain itself enforces (unbalanced posting, malformed
 * account, …). A duplicate-row conflict is a property of *this* persistence
 * adapter's concurrency control, not something the domain knows about — a
 * different repository implementation (e.g. in-memory) never raises it.
 * Mirrors `@apo/pay-core`'s
 * `src/adapters/persistence/drizzle/errors.ts` shape closely.
 */
export class LedgerPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The `(operation_id, account, direction)` unique index fired. A backstop
 * only — `post()`'s advisory-lock + in-transaction read is meant to make
 * this unreachable; if it ever surfaces, that serialization is broken.
 */
export class DuplicatePostingError extends LedgerPersistenceError {
  constructor(
    readonly operationId: string,
    options?: { cause?: unknown },
  ) {
    super(`Duplicate posting for operation "${operationId}"`, options);
  }
}

/** Postgres error shape carrying a SQLSTATE `code` (e.g. `23505` = unique_violation). */
interface PgErrorLike {
  readonly code: string;
  readonly constraint?: string;
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
  return pgErr.constraint === constraint;
}
