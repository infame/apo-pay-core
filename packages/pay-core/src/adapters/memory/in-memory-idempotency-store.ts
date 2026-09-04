import type {
  IdempotencyRecord,
  IdempotencyStore,
} from "../../ports/idempotency-store.js";

/**
 * In-memory idempotency store for tests and local demos. The real
 * implementation relies on a unique constraint on `key` to break ties between
 * concurrent first-requests; here access is single-threaded so a Map suffices.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async find(key: string): Promise<IdempotencyRecord | null> {
    return this.records.get(key) ?? null;
  }

  async save(record: IdempotencyRecord): Promise<void> {
    this.records.set(record.key, record);
  }
}
