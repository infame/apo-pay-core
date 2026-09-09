/**
 * Directive grammar for the SimulatorProvider. Outcome selection rides
 * entirely inside fields the PaymentProvider port already documents as
 * opaque strings (`paymentMethodToken` for authorize, `providerRef` for the
 * other three ops) — no port/domain change needed.
 *
 * Grammar: `sim.<outcome>` optionally `.{arg}`, dot-separated. Minted refs
 * additionally carry a `._.{uuid}` suffix:
 * `sim.<outcome>.<arg-or-underscore>._.{uuid}`.
 */

export type SimulatorOutcome =
  | { readonly kind: "approve" }
  | { readonly kind: "decline"; readonly declineCode: string }
  | { readonly kind: "fail_then_succeed"; readonly failures: number }
  | { readonly kind: "timeout" };

const DEFAULT_FAILURES = 1;

/**
 * Parses a directive out of an opaque carrier string (paymentMethodToken or
 * providerRef). Returns null when the string carries no directive (any
 * non-`sim.` value, or malformed arguments) — must be total, never throw, so
 * an arbitrary real-world token never crashes the adapter.
 */
export function parseDirective(value: string): SimulatorOutcome | null {
  if (!value.startsWith("sim.")) {
    return null;
  }

  const parts = value.split(".");
  const outcomeWord = parts[1];
  if (outcomeWord === undefined || outcomeWord === "") {
    return null;
  }

  switch (outcomeWord) {
    case "ok":
      return { kind: "approve" };
    case "decline": {
      const declineCode = parts[2];
      return {
        kind: "decline",
        declineCode:
          declineCode === undefined ? "generic_decline" : declineCode,
      };
    }
    case "fail_then_succeed": {
      const arg = parts[2];
      if (arg === undefined || arg === "_") {
        return { kind: "fail_then_succeed", failures: DEFAULT_FAILURES };
      }
      if (!/^\d+$/.test(arg)) {
        return null;
      }
      const failures = Number.parseInt(arg, 10);
      if (!Number.isFinite(failures) || failures < 0) {
        return null;
      }
      return { kind: "fail_then_succeed", failures };
    }
    case "timeout":
      return { kind: "timeout" };
    default:
      return null;
  }
}

/** Round-trips an outcome into the middle segments of a providerRef. */
export function encodeDirective(outcome: SimulatorOutcome): string {
  switch (outcome.kind) {
    case "approve":
      return "sim.ok";
    case "decline":
      return `sim.decline.${outcome.declineCode}`;
    case "fail_then_succeed":
      return `sim.fail_then_succeed.${outcome.failures}`;
    case "timeout":
      return "sim.timeout";
    default: {
      const exhaustive: never = outcome;
      throw new Error(
        `Unhandled simulator outcome: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
