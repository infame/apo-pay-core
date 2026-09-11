/**
 * Process entrypoint for the runnable `@apo/pay-core` HTTP service. Not
 * exported from `index.ts` — importing the library as a dependency must
 * never start a listener; this file is only ever run directly
 * (`node dist/main.js` / `pnpm start`).
 *
 * Wrapped in a top-level `try`/`catch` so a startup failure logs one clear
 * line and `process.exit(1)`s instead of surfacing as an unhandled
 * rejection.
 */
import { serve, type ServerType } from "@hono/node-server";
import { loadConfig, ConfigError, type AppConfig } from "./config.js";
import { createDb, createPool } from "./adapters/persistence/drizzle/db.js";
import { migrate } from "./adapters/persistence/drizzle/migrator.js";
import { MockProvider } from "./adapters/mock/mock-provider.js";
import { SimulatorProvider } from "./adapters/simulator/simulator-provider.js";
import type { PaymentProvider } from "./ports/payment-provider.js";
import { createPayCore } from "./composition-root.js";
import { createApp } from "./adapters/http/app.js";

let shuttingDown = false;

/** Runs pending migrations against a short-lived pool, separate from the
 * long-lived pool `createPayCore` builds for request traffic. Mirrors what
 * `run-migrate.ts` already does for the standalone `db:migrate` script. */
async function migrateOnBoot(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await migrate(createDb(pool));
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

/**
 * Builds the configured `PaymentProvider` via an explicit if/else, not an
 * object spread with an optional `seed` field: `SimulatorConfig` is a
 * discriminated union that requires `seed` on the `random` arm specifically,
 * and this repo's `exactOptionalPropertyTypes: true` rejects an
 * unconditionally-spread `seed?: number` there. The `undefined` check below
 * is what narrows `seed` to `number` for TypeScript, so no `!` non-null
 * assertion is needed — `loadConfig`'s `superRefine` already guarantees
 * `SIMULATOR_SEED` is set whenever mode is `random`, but TypeScript can't see
 * across that module boundary, so this re-checks it rather than asserting
 * past the compiler.
 */
function buildProvider(cfg: AppConfig): PaymentProvider {
  if (cfg.PAYMENT_PROVIDER === "mock") {
    return new MockProvider();
  }
  if (cfg.SIMULATOR_MODE === "random") {
    const seed = cfg.SIMULATOR_SEED;
    if (seed === undefined) {
      // Unreachable: loadConfig's superRefine rejects this combination at
      // boot before we ever get here.
      throw new ConfigError(
        "SIMULATOR_SEED is required when SIMULATOR_MODE=random",
      );
    }
    return new SimulatorProvider({ mode: "random", seed });
  }
  return new SimulatorProvider({ mode: "deterministic" });
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (cfg.MIGRATE_ON_BOOT) {
    await migrateOnBoot(cfg.DATABASE_URL);
  }

  const provider = buildProvider(cfg);
  const core = createPayCore({ databaseUrl: cfg.DATABASE_URL, provider });
  const app = createApp(core);

  const server: ServerType = serve(
    { fetch: app.fetch, port: cfg.PORT, hostname: cfg.HOST },
    (info) => {
      console.log(`pay-core listening on ${info.address}:${info.port}`);
    },
  );

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    // Arms a hard-exit fallback for the shutdown sequence itself: if
    // `server.close()`/`core.close()` hang, this fires before Docker's own
    // SIGKILL, so the failure is explicit and logged rather than silent.
    const forceExitTimer = setTimeout(() => {
      console.error(
        `pay-core: shutdown did not finish within ${cfg.SHUTDOWN_TIMEOUT_MS}ms, forcing exit`,
      );
      process.exit(1);
    }, cfg.SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    void (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
        await core.close();
        console.log(`pay-core (${signal}): shut down cleanly`);
        process.exit(0);
      } catch (err) {
        console.error("pay-core: error during shutdown", err);
        process.exit(1);
      }
    })();
  };

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
}

try {
  await main();
} catch (err) {
  console.error("pay-core: failed to start", err);
  process.exit(1);
}
