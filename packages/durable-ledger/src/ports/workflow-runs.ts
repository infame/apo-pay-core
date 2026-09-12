import type { PaymentExecuteRequested } from "../workflow/events.js";

/**
 * Driving port for starting and observing `payment.execute` runs, independent
 * of talking to Inngest directly. Mirrors this package's `PayCoreClient` port
 * in spirit: the HTTP layer (`../adapters/http/app.js`) depends only on this
 * interface, never on `Inngest` itself.
 *
 * There is deliberately no `workflow_runs` table — run status is read live
 * from Inngest's own REST API (`InngestWorkflowRuns`,
 * `../adapters/inngest/inngest-workflow-runs.js`) rather than mirrored into
 * this package's own Postgres schema. A caller looks a run up by the
 * server-assigned event id only; there is no way to supply your own
 * correlation key (an accepted limitation for this portfolio project).
 */
export type WorkflowRunStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

export interface WorkflowRunSnapshot {
  readonly eventId: string;
  /** `null` while `status === "queued"` — Inngest hasn't matched a run to the event yet. */
  readonly runId: string | null;
  readonly status: WorkflowRunStatus;
  /** ISO-8601, or `null` before the run has started. */
  readonly startedAt: string | null;
  /** ISO-8601, or `null` while the run is still in flight. */
  readonly endedAt: string | null;
  /** `true` iff `status === "failed"` AND the run's output contains `NEEDS_REVIEW_MARKER`. */
  readonly needsReview: boolean;
  readonly failureMessage: string | null;
}

export interface WorkflowRuns {
  startPaymentExecute(
    data: PaymentExecuteRequested,
  ): Promise<{ readonly eventId: string }>;
  /** `null` when Inngest has no record of this event id at all. */
  findByEventId(eventId: string): Promise<WorkflowRunSnapshot | null>;
}

/** Raised when Inngest's API can't be reached or answers with a server-side failure (>= 500). */
export class WorkflowEngineUnavailableError extends Error {
  readonly code = "workflow_engine_unavailable";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
