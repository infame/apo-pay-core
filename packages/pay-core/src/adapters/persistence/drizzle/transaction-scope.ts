import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import type { Database, PgPool } from "./db.js";

interface AmbientTx {
  readonly client: PoolClient;
  readonly db: Database;
}

interface ScopeState {
  tx: AmbientTx | null;
}

/**
 * Ambient transaction boundary for the Postgres adapters, via
 * `AsyncLocalStorage` rather than an explicit `UnitOfWork` port threaded
 * through every call. A composition-root wrapper does `scope.run(() =>
 * useCase.execute(cmd))`; inside that call tree, `PgPaymentRepository` and
 * `PgIdempotencyStore` both resolve the *same* ambient transaction via
 * `current()`/`beginIfNeeded()` without either of them, or the use-case
 * itself, knowing a transaction is involved.
 *
 * Deliberately not a mutable field on the adapter instance: the repository
 * and store are constructed once and shared (a singleton per composition
 * root), so a "current tx" field on `this` would be clobbered by concurrent
 * requests. `AsyncLocalStorage` scopes the handle to the call chain of a
 * single `run()` instead.
 *
 * The transaction begins lazily, on the first *write* (`beginIfNeeded`), not
 * on `run()` itself — `findById` and any `PaymentProvider` call (network I/O
 * to the PSP) happen without a connection checked out of the pool, so a slow
 * provider or a read-only use case never holds a pooled connection idle.
 *
 * Resource cleanup: spec §4.2 asks for `Symbol.dispose`-based cleanup
 * (`using`). We evaluated it here and fell back to explicit try/catch/finally
 * instead: the connection's lifetime spans the *entire* ambient call tree
 * (`fn()`), and is only conditionally created, deep inside a nested call to
 * `beginIfNeeded()` — not at the point `run()` itself would declare a `using`
 * binding. A lexically-scoped `using` doesn't model "maybe acquired, by
 * someone else, partway through" cleanly, so try/finally (which also has to
 * choose COMMIT vs ROLLBACK, not just release) is the more honest fit here.
 */
export class TransactionScope {
  private readonly als = new AsyncLocalStorage<ScopeState>();
  private readonly poolDb: Database;

  constructor(private readonly pool: PgPool) {
    this.poolDb = drizzle(pool, { schema });
  }

  /**
   * Run `fn` under a fresh ambient scope. If `fn` (via `beginIfNeeded`) ever
   * begins a write transaction, it is committed when `fn` resolves and rolled
   * back if `fn` throws; either way the checked-out connection is released
   * back to the pool. If nothing ever wrote, no connection was checked out.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state: ScopeState = { tx: null };
    try {
      const result = await this.als.run(state, fn);
      if (state.tx) {
        await state.tx.client.query("COMMIT");
      }
      return result;
    } catch (err) {
      if (state.tx) {
        await state.tx.client.query("ROLLBACK");
      }
      throw err;
    } finally {
      state.tx?.client.release();
    }
  }

  /**
   * Read handle: the ambient transaction if one has begun, otherwise the pool
   * directly (any connection may serve a read; nothing to keep pinned).
   */
  current(): Database {
    return this.als.getStore()?.tx?.db ?? this.poolDb;
  }

  /**
   * Write handle: begins the ambient transaction on the first call within a
   * `run()` scope and returns the same one on subsequent calls.
   */
  async beginIfNeeded(): Promise<Database> {
    const state = this.als.getStore();
    if (!state) {
      throw new Error(
        "TransactionScope.beginIfNeeded() called outside of scope.run()",
      );
    }
    if (!state.tx) {
      const client = await this.pool.connect();
      await client.query("BEGIN");
      state.tx = { client, db: drizzle(client, { schema }) };
    }
    return state.tx.db;
  }
}
