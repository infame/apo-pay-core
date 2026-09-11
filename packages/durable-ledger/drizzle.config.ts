import { defineConfig } from "drizzle-kit";

/**
 * `schemaFilter: ["ledger"]` stops drizzle-kit from ever proposing to touch
 * (or drop) pay-core's `public`-schema tables when it introspects the
 * shared Postgres instance — this package's tables all live in their own
 * `ledger` schema (see `src/adapters/persistence/drizzle/schema.ts`).
 * `migrations.schema: "ledger"` keeps the migration journal itself
 * (`__drizzle_migrations`) in that same schema, isolated from pay-core's —
 * see `migrator.ts` for why that isolation matters at apply time.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/adapters/persistence/drizzle/schema.ts",
  out: "./drizzle",
  schemaFilter: ["ledger"],
  migrations: { schema: "ledger", table: "__drizzle_migrations" },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://apo:apo@localhost:5433/apo",
  },
});
