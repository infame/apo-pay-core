import { Inngest } from "inngest";

const DEFAULT_CLIENT_ID = "apo-durable-ledger";

export interface InngestClientOptions {
  /** Defaults to `"apo-durable-ledger"`. */
  readonly id?: string;
  /**
   * Explicitly forces dev vs cloud mode. Left `undefined` by default so
   * `Inngest` resolves its own `mode` getter lazily from the `INNGEST_DEV`
   * env var (confirmed against `inngest@4.20.0`'s `components/Inngest.js`:
   * `mode` reads `this.options.isDev` first, falling back to
   * `parseAsBoolean(env.INNGEST_DEV)` — "1"/"true" for dev, "0"/"false" for
   * cloud). Do not reimplement that parsing here; passing `isDev` through
   * verbatim keeps this client honoring whatever the SDK itself decides.
   *
   * **What happens without dev mode and without a signing key:** `inngest@4.20.0`
   * does NOT throw at client construction or at `createFunction` time. In
   * cloud mode (`isDev` false/unset and `INNGEST_DEV` unset), the client logs
   * an error via its internal logger ("In cloud mode but no signing key
   * found...", `helpers/env.js`'s `checkModeConfiguration`) the first time
   * that's checked, but keeps running — registration/execution requests that
   * actually need to authenticate against Inngest Cloud will fail at that
   * point instead. For local development (this package's tests, and the
   * eventual `main.ts` in step 8), set `INNGEST_DEV=1` or pass `isDev: true`.
   */
  readonly isDev?: boolean;
  readonly baseUrl?: string;
  readonly eventKey?: string;
}

/**
 * Composition-root factory for this package's one `Inngest` client. Kept
 * thin and adapter-shaped (mirrors `HttpPayCoreClient`'s constructor-options
 * style) — the workflow layer (`../../workflow/payment-execute.js`) depends
 * only on the plain `Inngest` type, never on this factory, so tests can
 * construct their own client (or none at all, via `@inngest/test`) without
 * importing this file.
 */
export function createInngestClient(opts?: InngestClientOptions): Inngest {
  return new Inngest({
    id: opts?.id ?? DEFAULT_CLIENT_ID,
    ...(opts?.isDev !== undefined ? { isDev: opts.isDev } : {}),
    ...(opts?.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts?.eventKey !== undefined ? { eventKey: opts.eventKey } : {}),
  });
}
