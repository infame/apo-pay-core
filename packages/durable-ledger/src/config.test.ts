import { describe, expect, it } from "vitest";
import { loadConfig, ConfigError } from "./config.js";

const BASE_ENV = {
  DATABASE_URL: "postgres://apo:apo@localhost:5433/apo",
  PAY_CORE_URL: "http://localhost:3000",
};

describe("loadConfig", () => {
  it("applies documented defaults when only the required vars are set", () => {
    const cfg = loadConfig(BASE_ENV);

    expect(cfg.DATABASE_URL).toBe(BASE_ENV.DATABASE_URL);
    expect(cfg.PAY_CORE_URL).toBe(BASE_ENV.PAY_CORE_URL);
    expect(cfg.PAY_CORE_TIMEOUT_MS).toBe(10_000);
    expect(cfg.PORT).toBe(3100);
    expect(cfg.HOST).toBe("0.0.0.0");
    expect(cfg.INNGEST_APP_ID).toBe("apo-durable-ledger");
    expect(cfg.INNGEST_DEV).toBe(true);
    expect(cfg.INNGEST_BASE_URL).toBe("http://localhost:8288");
    expect(cfg.INNGEST_API_BASE_URL).toBeUndefined();
    expect(cfg.INNGEST_SERVE_PATH).toBe("/api/inngest");
    expect(cfg.INNGEST_EVENT_KEY).toBeUndefined();
    expect(cfg.INNGEST_SIGNING_KEY).toBeUndefined();
    expect(cfg.MIGRATE_ON_BOOT).toBe(true);
    expect(cfg.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });

  it("throws a ConfigError naming DATABASE_URL and PAY_CORE_URL when both are missing", () => {
    try {
      loadConfig({});
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("PAY_CORE_URL");
    }
  });

  it("rejects a non-URL PAY_CORE_URL", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, PAY_CORE_URL: "not-a-url" }),
    ).toThrow(ConfigError);
  });

  it("coerces INNGEST_DEV=1/0 and true/false to booleans", () => {
    expect(loadConfig({ ...BASE_ENV, INNGEST_DEV: "1" }).INNGEST_DEV).toBe(
      true,
    );
    expect(loadConfig({ ...BASE_ENV, INNGEST_DEV: "true" }).INNGEST_DEV).toBe(
      true,
    );
    expect(
      loadConfig({
        ...BASE_ENV,
        INNGEST_DEV: "0",
        INNGEST_SIGNING_KEY: "sk_test",
        INNGEST_EVENT_KEY: "ek_test",
      }).INNGEST_DEV,
    ).toBe(false);
    expect(
      loadConfig({
        ...BASE_ENV,
        INNGEST_DEV: "false",
        INNGEST_SIGNING_KEY: "sk_test",
        INNGEST_EVENT_KEY: "ek_test",
      }).INNGEST_DEV,
    ).toBe(false);
  });

  it("rejects an unrecognized INNGEST_DEV value", () => {
    expect(() => loadConfig({ ...BASE_ENV, INNGEST_DEV: "yes" })).toThrow(
      ConfigError,
    );
  });

  it("throws naming INNGEST_SIGNING_KEY when INNGEST_DEV=false without one", () => {
    try {
      loadConfig({
        ...BASE_ENV,
        INNGEST_DEV: "false",
        INNGEST_EVENT_KEY: "ek_test",
      });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("INNGEST_SIGNING_KEY");
    }
  });

  it("throws naming INNGEST_EVENT_KEY when INNGEST_DEV=false without one", () => {
    try {
      loadConfig({
        ...BASE_ENV,
        INNGEST_DEV: "false",
        INNGEST_SIGNING_KEY: "sk_test",
      });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("INNGEST_EVENT_KEY");
    }
  });

  it("accepts INNGEST_DEV=false when both keys are set", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INNGEST_DEV: "false",
      INNGEST_SIGNING_KEY: "sk_test",
      INNGEST_EVENT_KEY: "ek_test",
    });
    expect(cfg.INNGEST_DEV).toBe(false);
    expect(cfg.INNGEST_SIGNING_KEY).toBe("sk_test");
    expect(cfg.INNGEST_EVENT_KEY).toBe("ek_test");
  });

  it("does not require either Inngest key when INNGEST_DEV is left at its default (dev mode)", () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.INNGEST_SIGNING_KEY).toBeUndefined();
    expect(cfg.INNGEST_EVENT_KEY).toBeUndefined();
  });

  it("never leaks a supplied secret/URL value into the ConfigError message", () => {
    const secretSigningKey = "sk_super_secret_value_12345";
    try {
      loadConfig({
        ...BASE_ENV,
        PAY_CORE_URL: "not-a-url",
        INNGEST_DEV: "false",
        INNGEST_SIGNING_KEY: secretSigningKey,
      });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).not.toContain(secretSigningKey);
      expect(message).not.toContain("not-a-url");
      expect(message).toContain("PAY_CORE_URL");
      expect(message).toContain("INNGEST_EVENT_KEY");
    }
  });

  it("coerces numeric env vars", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      PORT: "4000",
      PAY_CORE_TIMEOUT_MS: "5000",
      SHUTDOWN_TIMEOUT_MS: "2000",
    });
    expect(cfg.PORT).toBe(4000);
    expect(cfg.PAY_CORE_TIMEOUT_MS).toBe(5000);
    expect(cfg.SHUTDOWN_TIMEOUT_MS).toBe(2000);
  });

  it("transforms MIGRATE_ON_BOOT=false to a boolean false", () => {
    const cfg = loadConfig({ ...BASE_ENV, MIGRATE_ON_BOOT: "false" });
    expect(cfg.MIGRATE_ON_BOOT).toBe(false);
  });

  it("defaults to process.env when no env argument is passed", () => {
    const previousDb = process.env.DATABASE_URL;
    const previousPayCore = process.env.PAY_CORE_URL;
    process.env.DATABASE_URL = BASE_ENV.DATABASE_URL;
    process.env.PAY_CORE_URL = BASE_ENV.PAY_CORE_URL;
    try {
      const cfg = loadConfig();
      expect(cfg.DATABASE_URL).toBe(BASE_ENV.DATABASE_URL);
      expect(cfg.PAY_CORE_URL).toBe(BASE_ENV.PAY_CORE_URL);
    } finally {
      if (previousDb === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDb;
      }
      if (previousPayCore === undefined) {
        delete process.env.PAY_CORE_URL;
      } else {
        process.env.PAY_CORE_URL = previousPayCore;
      }
    }
  });
});
