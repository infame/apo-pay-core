import { randomUUID } from "node:crypto";
import {
  ProviderDeclinedError,
  ProviderUnavailableError,
  type AuthorizeParams,
  type AuthorizeResult,
  type CancelParams,
  type CaptureParams,
  type PaymentProvider,
  type RefundParams,
} from "../../ports/payment-provider.js";
import {
  encodeDirective,
  parseDirective,
  type SimulatorOutcome,
} from "./directives.js";
import { createRng } from "./rng.js";

export type SimulatorConfig =
  | {
      readonly mode: "deterministic";
      readonly defaultOutcome?: SimulatorOutcome;
    }
  | {
      readonly mode: "random";
      readonly seed: number;
      readonly weights?: Readonly<
        Partial<Record<SimulatorOutcome["kind"], number>>
      >;
    };

export type ProviderOperation = "authorize" | "capture" | "refund" | "cancel";

/** Weights used in `random` mode when the caller doesn't override them. */
const DEFAULT_WEIGHTS: Readonly<Record<SimulatorOutcome["kind"], number>> = {
  approve: 90,
  decline: 5,
  fail_then_succeed: 3,
  timeout: 2,
};

const OUTCOME_KINDS = [
  "approve",
  "decline",
  "fail_then_succeed",
  "timeout",
] as const;

/**
 * Simulated PSP adapter for `PaymentProvider`. Outcomes are driven by a
 * directive embedded in the call's carrier string (`paymentMethodToken` for
 * `authorize`, the minted `providerRef` for `capture`/`refund`/`cancel`) —
 * see `directives.ts`. Absent a directive, falls back to the configured
 * deterministic default or a weighted random draw.
 *
 * Attempt counters for `fail_then_succeed` are keyed on `${operation}:${carrier}`,
 * deliberately NOT on `paymentId`: `CreatePayment` mints a fresh `paymentId`
 * per call and throws before `repo.save()` on a transient failure, so a
 * caller's retry arrives with a different `paymentId` but the same
 * `paymentMethodToken`. Keying on `paymentId` would make `fail_then_succeed`
 * never actually succeed on retry.
 */
export class SimulatorProvider implements PaymentProvider {
  readonly name = "simulator";

  private readonly config: SimulatorConfig;
  private readonly newId: () => string;
  private readonly rng: (() => number) | null;
  private readonly attemptCounts = new Map<string, number>();

  constructor(
    config: SimulatorConfig = { mode: "deterministic" },
    newId: () => string = () => randomUUID(),
  ) {
    this.config = config;
    this.newId = newId;
    this.rng = config.mode === "random" ? createRng(config.seed) : null;
  }

  /** Clears fail-then-succeed attempt counters. Call between tests. */
  reset(): void {
    this.attemptCounts.clear();
  }

  /** Test introspection: calls seen so far for a given (operation, carrier) counter key. */
  attempts(operation: ProviderOperation, key: string): number {
    return this.attemptCounts.get(counterKey(operation, key)) ?? 0;
  }

  async authorize(params: AuthorizeParams): Promise<AuthorizeResult> {
    const carrier = params.paymentMethodToken;
    const outcome = this.resolveOutcome(carrier);
    await this.applyOutcome("authorize", carrier, outcome);
    return { providerRef: `${encodeDirective(outcome)}._.${this.newId()}` };
  }

  async capture(params: CaptureParams): Promise<void> {
    const carrier = params.providerRef;
    const outcome = this.resolveOutcome(carrier);
    await this.applyOutcome("capture", carrier, outcome);
  }

  async refund(params: RefundParams): Promise<void> {
    const carrier = params.providerRef;
    const outcome = this.resolveOutcome(carrier);
    await this.applyOutcome("refund", carrier, outcome);
  }

  async cancel(params: CancelParams): Promise<void> {
    const carrier = params.providerRef;
    const outcome = this.resolveOutcome(carrier);
    await this.applyOutcome("cancel", carrier, outcome);
  }

  /** Resolution order: directive in the carrier wins; else mode default. */
  private resolveOutcome(carrier: string): SimulatorOutcome {
    const directive = parseDirective(carrier);
    if (directive) {
      return directive;
    }
    if (this.config.mode === "deterministic") {
      return this.config.defaultOutcome ?? { kind: "approve" };
    }
    return this.drawRandomOutcome();
  }

  private drawRandomOutcome(): SimulatorOutcome {
    const rng = this.rng;
    if (this.config.mode !== "random" || !rng) {
      // Unreachable given resolveOutcome only calls this in random mode.
      return { kind: "approve" };
    }
    const weights = this.config.weights;
    const total = OUTCOME_KINDS.reduce(
      (sum, kind) => sum + weightFor(kind, weights),
      0,
    );
    if (total <= 0) {
      return { kind: "approve" };
    }

    const draw = rng() * total;
    let cumulative = 0;
    for (const kind of OUTCOME_KINDS) {
      cumulative += weightFor(kind, weights);
      if (draw < cumulative) {
        return outcomeForKind(kind);
      }
    }
    // Floating-point edge case: draw landed exactly on the total. Fall back
    // to approve rather than throwing.
    return { kind: "approve" };
  }

  private async applyOutcome(
    operation: ProviderOperation,
    carrier: string,
    outcome: SimulatorOutcome,
  ): Promise<void> {
    switch (outcome.kind) {
      case "approve":
        return;
      case "decline":
        throw new ProviderDeclinedError(
          "simulated decline",
          outcome.declineCode,
        );
      case "timeout":
        throw new ProviderUnavailableError("timeout");
      case "fail_then_succeed": {
        const key = counterKey(operation, carrier);
        const attempt = (this.attemptCounts.get(key) ?? 0) + 1;
        this.attemptCounts.set(key, attempt);
        if (attempt <= outcome.failures) {
          throw new ProviderUnavailableError(
            `simulated transient failure (attempt ${attempt}/${outcome.failures})`,
          );
        }
        return;
      }
      default: {
        const exhaustive: never = outcome;
        throw new Error(
          `Unhandled simulator outcome: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }
}

function counterKey(operation: ProviderOperation, carrier: string): string {
  return `${operation}:${carrier}`;
}

function weightFor(
  kind: SimulatorOutcome["kind"],
  weights:
    Readonly<Partial<Record<SimulatorOutcome["kind"], number>>> | undefined,
): number {
  if (weights === undefined) {
    return DEFAULT_WEIGHTS[kind];
  }
  return weights[kind] ?? 0;
}

function outcomeForKind(kind: SimulatorOutcome["kind"]): SimulatorOutcome {
  switch (kind) {
    case "approve":
      return { kind: "approve" };
    case "decline":
      return { kind: "decline", declineCode: "random_decline" };
    case "fail_then_succeed":
      return { kind: "fail_then_succeed", failures: 1 };
    case "timeout":
      return { kind: "timeout" };
    default: {
      const exhaustive: never = kind;
      throw new Error(
        `Unhandled simulator outcome kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
