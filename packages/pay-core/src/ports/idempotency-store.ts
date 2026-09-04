/**
 * Idempotency port.
 *
 * Clients send an `Idempotency-Key` with mutating requests. The first request
 * for a key runs the operation and stores its result; retries with the same
 * key return the stored result instead of re-executing. This makes POSTs safe
 * to retry (network blips, double clicks, at-least-once webhooks) without
 * double-charging.
 *
 * A production implementation keys on (idempotencyKey, requestFingerprint) so
 * that reusing a key with a *different* body is rejected rather than silently
 * returning a mismatched result.
 */
export interface IdempotencyStore {
  /**
   * Return a stored record for this key, or null if unseen.
   * `requestFingerprint` is a hash of the request payload.
   */
  find(key: string): Promise<IdempotencyRecord | null>;

  /**
   * Persist the result for a key. Implementations should enforce uniqueness on
   * the key so concurrent first-requests can't both win.
   */
  save(record: IdempotencyRecord): Promise<void>;
}

export interface IdempotencyRecord {
  readonly key: string;
  readonly requestFingerprint: string;
  /** Serialized response payload returned to retries. */
  readonly response: unknown;
  readonly createdAt: Date;
}

/** Same key reused with a different request body. */
export class IdempotencyConflictError extends Error {
  constructor(readonly key: string) {
    super(`Idempotency key "${key}" was reused with a different request`);
    this.name = "IdempotencyConflictError";
  }
}
