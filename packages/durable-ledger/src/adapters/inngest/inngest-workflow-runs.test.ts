import { Inngest } from "inngest";
import { afterEach, describe, expect, it } from "vitest";
import {
  startFakeInngestApi,
  type FakeInngestApiServer,
} from "./fake-inngest-api-server.js";
import { InngestWorkflowRuns } from "./inngest-workflow-runs.js";
import { WorkflowEngineUnavailableError } from "../../ports/workflow-runs.js";
import { NEEDS_REVIEW_MARKER } from "../../workflow/compensation.js";

function jsonResponse(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("InngestWorkflowRuns", () => {
  let server: FakeInngestApiServer;
  const inngest = new Inngest({ id: "test-client" });

  afterEach(async () => {
    await server.close();
  });

  function buildRuns(opts?: { signingKey?: string }): InngestWorkflowRuns {
    return new InngestWorkflowRuns({
      inngest,
      apiBaseUrl: server.baseUrl,
      ...(opts?.signingKey !== undefined
        ? { signingKey: opts.signingKey }
        : {}),
    });
  }

  describe("findByEventId", () => {
    it("classifies an HTTP-200-with-error-envelope (status: 400) as an unknown event, returning null", async () => {
      server = await startFakeInngestApi({
        listRunsForEvent: (_ctx, res) => {
          jsonResponse(res, 200, {
            data: null,
            error: "event not found",
            status: 400,
          });
        },
      });
      const runs = buildRuns();

      const result = await runs.findByEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(result).toBeNull();
    });

    it("returns queued with a null runId when the runs list is empty", async () => {
      server = await startFakeInngestApi({
        listRunsForEvent: (_ctx, res) => {
          jsonResponse(res, 200, { data: [], status: 200 });
        },
      });
      const runs = buildRuns();

      const result = await runs.findByEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(result).toEqual({
        eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        runId: null,
        status: "queued",
        startedAt: null,
        endedAt: null,
        needsReview: false,
        failureMessage: null,
      });
    });

    it("prefers the second call's status over a stale first-call status (two-hop precedence)", async () => {
      server = await startFakeInngestApi({
        listRunsForEvent: (_ctx, res) => {
          // The list endpoint reports a stale "Completed" status for the run.
          jsonResponse(res, 200, {
            data: [{ run_id: "run_1", status: "Completed" }],
            status: 200,
          });
        },
        getRun: (_ctx, res) => {
          // The authoritative run-detail endpoint says it's actually still running.
          jsonResponse(res, 200, {
            data: {
              run_id: "run_1",
              status: "Running",
              run_started_at: "2026-01-01T00:00:00.000Z",
              ended_at: null,
            },
            status: 200,
          });
        },
      });
      const runs = buildRuns();

      const result = await runs.findByEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(result?.status).toBe("running");
      expect(result?.runId).toBe("run_1");
      expect(result?.startedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(result?.endedAt).toBeNull();
    });

    it("derives needsReview: true from a failed run whose output contains the marker", async () => {
      server = await startFakeInngestApi({
        listRunsForEvent: (_ctx, res) => {
          jsonResponse(res, 200, {
            data: [{ run_id: "run_2", status: "Failed" }],
            status: 200,
          });
        },
        getRun: (_ctx, res) => {
          jsonResponse(res, 200, {
            data: {
              run_id: "run_2",
              status: "Failed",
              run_started_at: "2026-01-01T00:00:00.000Z",
              ended_at: "2026-01-01T00:01:00.000Z",
              output: {
                message: `payment.execute ${NEEDS_REVIEW_MARKER} step "capture" failed (attempts_exhausted); no compensation attempted`,
              },
            },
            status: 200,
          });
        },
      });
      const runs = buildRuns();

      const result = await runs.findByEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(result?.status).toBe("failed");
      expect(result?.needsReview).toBe(true);
      expect(result?.failureMessage).toContain(NEEDS_REVIEW_MARKER);
    });

    it("derives needsReview: false from a failed run whose output does not contain the marker", async () => {
      server = await startFakeInngestApi({
        listRunsForEvent: (_ctx, res) => {
          jsonResponse(res, 200, {
            data: [{ run_id: "run_3", status: "Failed" }],
            status: 200,
          });
        },
        getRun: (_ctx, res) => {
          jsonResponse(res, 200, {
            data: {
              run_id: "run_3",
              status: "Failed",
              output: {
                message:
                  'payment.execute failed at step "capture" (terminal_error); compensated: cancel-authorization',
              },
            },
            status: 200,
          });
        },
      });
      const runs = buildRuns();

      const result = await runs.findByEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(result?.status).toBe("failed");
      expect(result?.needsReview).toBe(false);
      expect(result?.failureMessage).toContain("compensated");
    });

    it("throws WorkflowEngineUnavailableError on a >= 500 envelope status from the list endpoint", async () => {
      server = await startFakeInngestApi({
        listRunsForEvent: (_ctx, res) => {
          jsonResponse(res, 200, { data: null, error: "boom", status: 500 });
        },
      });
      const runs = buildRuns();

      await expect(
        runs.findByEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      ).rejects.toBeInstanceOf(WorkflowEngineUnavailableError);
    });

    it("throws WorkflowEngineUnavailableError on a >= 500 envelope status from the run-detail endpoint", async () => {
      server = await startFakeInngestApi({
        listRunsForEvent: (_ctx, res) => {
          jsonResponse(res, 200, {
            data: [{ run_id: "run_4", status: "Running" }],
            status: 200,
          });
        },
        getRun: (_ctx, res) => {
          jsonResponse(res, 200, { data: null, error: "boom", status: 503 });
        },
      });
      const runs = buildRuns();

      await expect(
        runs.findByEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      ).rejects.toBeInstanceOf(WorkflowEngineUnavailableError);
    });

    it("throws WorkflowEngineUnavailableError when the connection is refused", async () => {
      const runs = new InngestWorkflowRuns({
        inngest,
        apiBaseUrl: "http://127.0.0.1:1",
        timeoutMs: 500,
      });
      server = await startFakeInngestApi();

      await expect(
        runs.findByEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      ).rejects.toBeInstanceOf(WorkflowEngineUnavailableError);
    });

    it("sends an Authorization header iff a signingKey is configured, and never leaks it in a thrown error", async () => {
      const secretSigningKey = "signkey_super_secret_abc123";
      server = await startFakeInngestApi({
        listRunsForEvent: (_ctx, res) => {
          jsonResponse(res, 200, { data: null, error: "boom", status: 500 });
        },
      });
      const runsWithKey = buildRuns({ signingKey: secretSigningKey });

      try {
        await runsWithKey.findByEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
        throw new Error("expected findByEventId to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkflowEngineUnavailableError);
        expect((err as Error).message).not.toContain(secretSigningKey);
      }

      const recorded = server.requests.at(-1);
      expect(recorded?.headers.Authorization).toBe(
        `Bearer ${secretSigningKey}`,
      );

      const runsWithoutKey = buildRuns();
      await expect(
        runsWithoutKey.findByEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      ).rejects.toBeInstanceOf(WorkflowEngineUnavailableError);
      const recordedNoKey = server.requests.at(-1);
      expect(recordedNoKey?.headers.Authorization).toBeUndefined();
    });
  });

  describe("startPaymentExecute", () => {
    it("throws WorkflowEngineUnavailableError when inngest.send rejects", async () => {
      server = await startFakeInngestApi();
      const failingClient = {
        send: () => Promise.reject(new Error("network down")),
      } as unknown as Inngest;
      const runs = new InngestWorkflowRuns({
        inngest: failingClient,
        apiBaseUrl: server.baseUrl,
      });

      await expect(
        runs.startPaymentExecute({
          amount: 1000,
          currency: "USD",
          paymentMethodToken: "tok_visa",
          merchantId: "merchant_1",
        }),
      ).rejects.toBeInstanceOf(WorkflowEngineUnavailableError);
    });

    it("throws WorkflowEngineUnavailableError when send resolves with no ids", async () => {
      server = await startFakeInngestApi();
      const emptyIdsClient = {
        send: () => Promise.resolve({ ids: [] }),
      } as unknown as Inngest;
      const runs = new InngestWorkflowRuns({
        inngest: emptyIdsClient,
        apiBaseUrl: server.baseUrl,
      });

      await expect(
        runs.startPaymentExecute({
          amount: 1000,
          currency: "USD",
          paymentMethodToken: "tok_visa",
          merchantId: "merchant_1",
        }),
      ).rejects.toBeInstanceOf(WorkflowEngineUnavailableError);
    });

    it("returns the eventId from a successful send", async () => {
      server = await startFakeInngestApi();
      const okClient = {
        send: () => Promise.resolve({ ids: ["evt_123"] }),
      } as unknown as Inngest;
      const runs = new InngestWorkflowRuns({
        inngest: okClient,
        apiBaseUrl: server.baseUrl,
      });

      const result = await runs.startPaymentExecute({
        amount: 1000,
        currency: "USD",
        paymentMethodToken: "tok_visa",
        merchantId: "merchant_1",
      });
      expect(result).toEqual({ eventId: "evt_123" });
    });
  });
});
