import { describe, expect, it } from "vitest";
import { Money } from "../../domain/money.js";
import {
  ProviderDeclinedError,
  ProviderError,
  ProviderUnavailableError,
} from "../../ports/payment-provider.js";
import { parseDirective } from "./directives.js";
import { SimulatorProvider } from "./simulator-provider.js";

const AMOUNT = Money.of(2000, "USD");

function authorizeWith(
  provider: SimulatorProvider,
  paymentMethodToken: string,
  paymentId = "pay_1",
) {
  return provider.authorize({ paymentId, amount: AMOUNT, paymentMethodToken });
}

describe("SimulatorProvider — deterministic outcomes", () => {
  it("sim.ok resolves with a sim.-prefixed ref", async () => {
    const provider = new SimulatorProvider();
    const { providerRef } = await authorizeWith(provider, "sim.ok");
    expect(providerRef.startsWith("sim.")).toBe(true);
    expect(parseDirective(providerRef)).toEqual({ kind: "approve" });
  });

  it("sim.decline.insufficient_funds rejects a terminal decline", async () => {
    const provider = new SimulatorProvider();
    await expect(
      authorizeWith(provider, "sim.decline.insufficient_funds"),
    ).rejects.toMatchObject({
      declineCode: "insufficient_funds",
      retryable: false,
    });
  });

  it("sim.timeout rejects a retryable unavailable error", async () => {
    const provider = new SimulatorProvider();
    await expect(authorizeWith(provider, "sim.timeout")).rejects.toMatchObject({
      retryable: true,
    });
    await expect(authorizeWith(provider, "sim.timeout")).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it("falls through to defaultOutcome, defaulting to approve when unconfigured", async () => {
    const provider = new SimulatorProvider();
    const { providerRef } = await authorizeWith(provider, "tok_visa");
    expect(providerRef.startsWith("sim.ok.")).toBe(true);
  });

  it("honours a configured defaultOutcome for non-directive tokens", async () => {
    const provider = new SimulatorProvider({
      mode: "deterministic",
      defaultOutcome: { kind: "decline", declineCode: "card_expired" },
    });
    await expect(authorizeWith(provider, "tok_visa")).rejects.toMatchObject({
      declineCode: "card_expired",
    });
  });
});

describe("retryable/terminal contract (402 vs 503) — durable-ledger depends on this", () => {
  it("ProviderDeclinedError and ProviderUnavailableError are mutually exclusive, both ProviderError/Error", () => {
    const declined = new ProviderDeclinedError(
      "no funds",
      "insufficient_funds",
    );
    const unavailable = new ProviderUnavailableError("timeout");

    expect(declined).toBeInstanceOf(ProviderError);
    expect(declined).toBeInstanceOf(Error);
    expect(declined).not.toBeInstanceOf(ProviderUnavailableError);

    expect(unavailable).toBeInstanceOf(ProviderError);
    expect(unavailable).toBeInstanceOf(Error);
    expect(unavailable).not.toBeInstanceOf(ProviderDeclinedError);

    expect(declined.retryable).toBe(false);
    expect(unavailable.retryable).toBe(true);
  });
});

describe("SimulatorProvider — fail_then_succeed attempt tracking", () => {
  it("sim.fail_then_succeed.2 fails twice then succeeds, and keeps succeeding", async () => {
    const provider = new SimulatorProvider();
    const token = "sim.fail_then_succeed.2";

    await expect(authorizeWith(provider, token)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(authorizeWith(provider, token)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(authorizeWith(provider, token)).resolves.toMatchObject({});
    await expect(authorizeWith(provider, token)).resolves.toMatchObject({});
  });

  it("bare sim.fail_then_succeed defaults N to 1", async () => {
    const provider = new SimulatorProvider();
    const token = "sim.fail_then_succeed";

    await expect(authorizeWith(provider, token)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(authorizeWith(provider, token)).resolves.toMatchObject({});
  });

  it("two different tokens keep independent counters", async () => {
    const provider = new SimulatorProvider();
    // Both directives parse to the same outcome (failures: 1) but are
    // different carrier strings, so they must get independent counters.
    const tokenA = "sim.fail_then_succeed";
    const tokenB = "sim.fail_then_succeed.1";

    await expect(
      authorizeWith(provider, tokenA, "pay_a1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(
      authorizeWith(provider, tokenB, "pay_b1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    // tokenA's own second call still succeeds independently.
    await expect(
      authorizeWith(provider, tokenA, "pay_a2"),
    ).resolves.toMatchObject({});
  });

  it("reset() re-arms a previously exhausted counter", async () => {
    const provider = new SimulatorProvider();
    const token = "sim.fail_then_succeed";

    await expect(authorizeWith(provider, token)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(authorizeWith(provider, token)).resolves.toMatchObject({});

    provider.reset();

    await expect(authorizeWith(provider, token)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it("regression guard: same token, different paymentId per call, succeeds on the 3rd attempt (CreatePayment retry shape)", async () => {
    const provider = new SimulatorProvider();
    const token = "sim.fail_then_succeed.2";

    await expect(
      authorizeWith(provider, token, "pay_retry_1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(
      authorizeWith(provider, token, "pay_retry_2"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(
      authorizeWith(provider, token, "pay_retry_3"),
    ).resolves.toMatchObject({});
  });
});

describe("SimulatorProvider — providerRef round-trip into capture", () => {
  it("a fail_then_succeed authorize's minted ref reproduces flaky behaviour on capture, with its own counter", async () => {
    const provider = new SimulatorProvider();
    const token = "sim.fail_then_succeed.1";

    await expect(authorizeWith(provider, token)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    const { providerRef } = await authorizeWith(provider, token);
    expect(providerRef.startsWith("sim.fail_then_succeed.1.")).toBe(true);
    expect(provider.attempts("authorize", token)).toBe(2);

    // Capture on this ref must be flaky too, but on its own counter — it
    // hasn't been called yet, so its first attempt fails just like
    // authorize's first attempt did.
    await expect(
      provider.capture({ providerRef, amount: AMOUNT }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(provider.attempts("capture", providerRef)).toBe(1);
    expect(provider.attempts("authorize", token)).toBe(2); // untouched by capture

    await expect(
      provider.capture({ providerRef, amount: AMOUNT }),
    ).resolves.toBeUndefined();
  });

  it("a sim.ok-minted ref captures cleanly", async () => {
    const provider = new SimulatorProvider();
    const { providerRef } = await authorizeWith(provider, "sim.ok");
    await expect(
      provider.capture({ providerRef, amount: AMOUNT }),
    ).resolves.toBeUndefined();
  });
});

describe("SimulatorProvider — random mode", () => {
  async function drawSequence(
    provider: SimulatorProvider,
    count: number,
  ): Promise<string[]> {
    const results: string[] = [];
    for (let i = 0; i < count; i++) {
      try {
        await provider.authorize({
          paymentId: `pay_${i}`,
          amount: AMOUNT,
          paymentMethodToken: `tok_no_directive_${i}`,
        });
        results.push("approve");
      } catch (err) {
        if (err instanceof ProviderDeclinedError) {
          results.push(`decline:${err.declineCode ?? ""}`);
        } else if (err instanceof ProviderUnavailableError) {
          results.push(`unavailable:${err.reason}`);
        } else {
          throw err;
        }
      }
    }
    return results;
  }

  it("is deterministic for a given seed and different for a different seed", async () => {
    const providerA = new SimulatorProvider({ mode: "random", seed: 42 });
    const providerB = new SimulatorProvider({ mode: "random", seed: 42 });
    const providerC = new SimulatorProvider({ mode: "random", seed: 43 });

    const seqA = await drawSequence(providerA, 500);
    const seqB = await drawSequence(providerB, 500);
    const seqC = await drawSequence(providerC, 500);

    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it("weights: { decline: 100 } yields 100% declines", async () => {
    const provider = new SimulatorProvider({
      mode: "random",
      seed: 7,
      weights: { decline: 100 },
    });
    const seq = await drawSequence(provider, 200);
    expect(seq.every((outcome) => outcome.startsWith("decline:"))).toBe(true);
  });

  it("weights: { approve: 100 } yields zero errors", async () => {
    const provider = new SimulatorProvider({
      mode: "random",
      seed: 7,
      weights: { approve: 100 },
    });
    const seq = await drawSequence(provider, 200);
    expect(seq.every((outcome) => outcome === "approve")).toBe(true);
  });

  it("a directive-bearing token still overrides random mode", async () => {
    const provider = new SimulatorProvider({
      mode: "random",
      seed: 7,
      weights: { decline: 100 },
    });
    const { providerRef } = await authorizeWith(provider, "sim.ok");
    expect(providerRef.startsWith("sim.ok.")).toBe(true);

    await expect(
      authorizeWith(provider, "sim.decline.card_lost"),
    ).rejects.toMatchObject({ declineCode: "card_lost" });
  });
});

describe("parseDirective — grammar edge cases", () => {
  it.each([
    "",
    "tok_visa",
    "sim.",
    "sim.nonsense",
    "sim.fail_then_succeed.abc",
    "sim.fail_then_succeed.-1",
  ])("returns null (never throws) for %j", (value) => {
    expect(parseDirective(value)).toBeNull();
  });
});
