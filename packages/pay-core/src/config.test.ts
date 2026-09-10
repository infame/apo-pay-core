import { describe, expect, it } from "vitest";
import { loadConfig, ConfigError } from "./config.js";

const BASE_ENV = { DATABASE_URL: "postgres://apo:apo@localhost:5433/apo" };

describe("loadConfig", () => {
  it("applies documented defaults when only DATABASE_URL is set", () => {
    const cfg = loadConfig(BASE_ENV);

    expect(cfg.DATABASE_URL).toBe(BASE_ENV.DATABASE_URL);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.HOST).toBe("0.0.0.0");
    expect(cfg.PAYMENT_PROVIDER).toBe("simulator");
    expect(cfg.SIMULATOR_MODE).toBe("deterministic");
    expect(cfg.SIMULATOR_SEED).toBeUndefined();
    expect(cfg.MIGRATE_ON_BOOT).toBe(true);
    expect(cfg.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });

  it("throws a ConfigError listing DATABASE_URL when it is missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("DATABASE_URL");
    }
  });

  it("never leaks the value of an invalid variable in the error message", () => {
    try {
      loadConfig({ ...BASE_ENV, PORT: "not-a-port" });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).not.toContain("not-a-port");
      expect((err as ConfigError).message).toContain("PORT");
    }
  });

  it("lists every issue, one per line, when multiple variables are invalid", () => {
    try {
      loadConfig({ PORT: "not-a-port", PAYMENT_PROVIDER: "stripe" });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      const lines = message.split("\n").filter((line) => line.includes(":"));
      expect(lines.some((line) => line.startsWith("DATABASE_URL:"))).toBe(true);
      expect(lines.some((line) => line.startsWith("PORT:"))).toBe(true);
      expect(lines.some((line) => line.startsWith("PAYMENT_PROVIDER:"))).toBe(
        true,
      );
    }
  });

  it("coerces PORT and SHUTDOWN_TIMEOUT_MS from string env vars to numbers", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      PORT: "8080",
      SHUTDOWN_TIMEOUT_MS: "5000",
    });

    expect(cfg.PORT).toBe(8080);
    expect(cfg.SHUTDOWN_TIMEOUT_MS).toBe(5000);
  });

  it("rejects PORT out of the valid TCP range", () => {
    expect(() => loadConfig({ ...BASE_ENV, PORT: "70000" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...BASE_ENV, PORT: "0" })).toThrow(ConfigError);
  });

  it("rejects an unknown PAYMENT_PROVIDER", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, PAYMENT_PROVIDER: "stripe" }),
    ).toThrow(ConfigError);
  });

  it("transforms MIGRATE_ON_BOOT=false to a boolean false", () => {
    const cfg = loadConfig({ ...BASE_ENV, MIGRATE_ON_BOOT: "false" });
    expect(cfg.MIGRATE_ON_BOOT).toBe(false);
  });

  it("rejects a non-true/false MIGRATE_ON_BOOT value", () => {
    expect(() => loadConfig({ ...BASE_ENV, MIGRATE_ON_BOOT: "yes" })).toThrow(
      ConfigError,
    );
  });

  it("requires SIMULATOR_SEED when SIMULATOR_MODE=random", () => {
    try {
      loadConfig({
        ...BASE_ENV,
        PAYMENT_PROVIDER: "simulator",
        SIMULATOR_MODE: "random",
      });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("SIMULATOR_SEED");
    }
  });

  it("accepts SIMULATOR_MODE=random when SIMULATOR_SEED is set", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      SIMULATOR_MODE: "random",
      SIMULATOR_SEED: "42",
    });

    expect(cfg.SIMULATOR_MODE).toBe("random");
    expect(cfg.SIMULATOR_SEED).toBe(42);
  });

  it("does not require SIMULATOR_SEED when PAYMENT_PROVIDER=mock even in random mode", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      PAYMENT_PROVIDER: "mock",
      SIMULATOR_MODE: "random",
    });

    expect(cfg.PAYMENT_PROVIDER).toBe("mock");
    expect(cfg.SIMULATOR_SEED).toBeUndefined();
  });

  it("defaults to process.env when no env argument is passed", () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = BASE_ENV.DATABASE_URL;
    try {
      const cfg = loadConfig();
      expect(cfg.DATABASE_URL).toBe(BASE_ENV.DATABASE_URL);
    } finally {
      if (previous === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previous;
      }
    }
  });
});
