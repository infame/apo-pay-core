import type { Jsonify } from "inngest/types";

/**
 * The one piece of Inngest's `step` object this package's workflow logic
 * actually uses. Inngest's real `step` (the `step` field on a
 * `createFunction` handler's `ctx`) satisfies this structurally — no cast
 * needed at the call site in `payment-execute.ts` — and a test double can
 * implement it directly, which is what makes post-failure compensation
 * logic testable at all: `@inngest/test`'s `InngestTestEngine` cannot
 * execute any handler code after a step fails (see
 * `docs/adr/0009-compensation-routing-and-the-workflow-step-seam.md`), so
 * `runPaymentExecute` (`./payment-execute.js`) is written against this
 * narrower interface instead of Inngest's own `step`, and driven directly
 * by `FakeWorkflowStep` (`./fake-workflow-step.js`) in tests that need to
 * observe what happens after a step throws.
 *
 * The return type mirrors what Inngest's real `step.run` actually resolves
 * to with no middleware installed: `Jsonify<Awaited<...>>`, not a bare `T` —
 * `step.run`'s result crosses Inngest's own JSON serialization boundary
 * (a returned `Date` becomes a `string`, etc.), and a naive
 * `run<T>(id, fn): Promise<T>` signature is NOT assignable from Inngest's
 * real `step` for exactly that reason.
 */
export interface WorkflowStep {
  run<T>(
    id: string,
    fn: () => Promise<T>,
  ): Promise<Jsonify<Awaited<T extends void ? null : T>>>;
}
