import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./db.js";

/**
 * The migrations folder is resolved relative to this module's own location
 * (`import.meta.url`), not `process.cwd()` — this file is imported both from
 * `run-migrate.ts` (repo-root cwd) and from `vitest.integration.config.ts`'s
 * `globalSetup` (vitest's cwd), so a cwd-relative path would break one of the
 * two callers depending on how the process was launched.
 */
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../drizzle",
);

/** Apply all pending migrations from `drizzle/` to the given database. */
export async function migrate(db: Database): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder });
}
