import type { Jsonify } from "inngest/types";
import { serializeError, StepError } from "inngest";
import type { WorkflowStep } from "./workflow-step.js";

/**
 * Test support only — deliberately NOT exported from `src/index.ts` (matches
 * `./fake-pay-core-client.js`'s precedent). Implements `WorkflowStep` by
 * actually running each step's callback (unlike real Inngest, which
 * memoizes across re-invocations of the whole handler — this fake just
 * calls through once per `run()` invocation, which is sufficient for
 * driving `runPaymentExecute`'s control flow directly in a single pass).
 *
 * This is what makes post-failure compensation logic testable at all:
 * `@inngest/test`'s `InngestTestEngine` cannot execute any handler code
 * after a step fails (see
 * `docs/adr/0009-compensation-routing-and-the-workflow-step-seam.md`), so
 * `payment-execute-compensation.test.ts` drives `runPaymentExecute` against
 * this double instead.
 *
 * `scriptFailure(id, error)` pre-arms a step id to fail with the genuine
 * Inngest `StepError` shape (constructed via Inngest's own public
 * `StepError`/`serializeError`, not an approximation) the NEXT time that id
 * is run, without invoking any callback for it — mirrors how a real
 * memoized failed step behaves when replayed into user code.
 */
export class FakeWorkflowStep implements WorkflowStep {
  readonly ran: string[] = [];

  readonly #scriptedFailures = new Map<string, unknown>();

  scriptFailure(stepId: string, error: unknown): void {
    this.#scriptedFailures.set(stepId, error);
  }

  async run<T>(
    id: string,
    fn: () => Promise<T>,
  ): Promise<Jsonify<Awaited<T extends void ? null : T>>> {
    this.ran.push(id);

    if (this.#scriptedFailures.has(id)) {
      const scriptedFailure = this.#scriptedFailures.get(id);
      this.#scriptedFailures.delete(id);
      throw new StepError(id, serializeError(scriptedFailure));
    }

    const result = await fn();
    // Test-only cast: this fake never actually crosses Inngest's JSON
    // serialization boundary, so the runtime value is exactly `T`, not a
    // `Jsonify`'d transform of it — production code avoids `as`, but this
    // is the one documented exception, confined to test support.
    return result as Jsonify<Awaited<T extends void ? null : T>>;
  }
}
