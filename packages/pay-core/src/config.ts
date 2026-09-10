import { z } from "zod";

/**
 * Process-level configuration, parsed once at boot (`main.ts`). Not exported
 * from `index.ts` — this is bootstrap wiring for the runnable service, not
 * library surface; consumers embedding `@apo/pay-core` build their own
 * `CreatePayCoreOptions` directly.
 */
export const AppConfig = z
  .object({
    DATABASE_URL: z.string().min(1),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default("0.0.0.0"),
    PAYMENT_PROVIDER: z.enum(["simulator", "mock"]).default("simulator"),
    SIMULATOR_MODE: z
      .enum(["deterministic", "random"])
      .default("deterministic"),
    SIMULATOR_SEED: z.coerce.number().int().optional(),
    MIGRATE_ON_BOOT: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .superRefine((cfg, ctx) => {
    // random mode without a seed is not reproducible -> reject at boot, not
    // at first request.
    if (
      cfg.PAYMENT_PROVIDER === "simulator" &&
      cfg.SIMULATOR_MODE === "random" &&
      cfg.SIMULATOR_SEED === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SIMULATOR_SEED"],
        message: "SIMULATOR_SEED is required when SIMULATOR_MODE=random",
      });
    }
  });
export type AppConfig = z.infer<typeof AppConfig>;

/** Raised when process env fails to satisfy `AppConfig`. Never includes the
 * value of any variable in its message (`DATABASE_URL` carries a password) —
 * only the field path and Zod's issue message, one issue per line. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Parses `env` (defaults to `process.env`) into a validated `AppConfig`.
 * Throws `ConfigError` with every issue listed, one per line, as
 * `"PATH: message"` — the point is a missing `DATABASE_URL` produces one
 * clear boot-time message instead of a `pg` `ECONNREFUSED` twenty stack
 * frames deep.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  try {
    return AppConfig.parse(env);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n");
      throw new ConfigError(`Invalid configuration:\n${issues}`);
    }
    throw err;
  }
}
