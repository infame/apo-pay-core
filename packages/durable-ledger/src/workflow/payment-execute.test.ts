import { InngestTestEngine } from "@inngest/test";
import { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import {
  createPaymentExecuteFunction,
  type PaymentExecuteResult,
} from "./payment-execute.js";
import {
  authorizedPaymentResponse,
  capturedPaymentResponse,
  declinedAtAuthorizeResponse,
  FakePayCoreClient,
} from "./fake-pay-core-client.js";
import { InMemoryLedgerRepository } from "../adapters/memory/in-memory-ledger-repository.js";
import { paymentExecuteRequestedSchema } from "./events.js";
import { stepIdempotencyKey } from "./idempotency-key.js";
import {
  PayCoreDeclinedError,
  PayCoreUnavailableError,
} from "../ports/pay-core-errors.js";
import { PostingConflictError } from "../ports/ledger-repository.js";
import { LedgerAccount } from "../domain/account.js";
import { balanceOf } from "../domain/balances.js";
import { DEFAULT_RETRY_POLICY } from "./retry-policy.js";

/**
 * `@inngest/test`'s `InngestTestEngine` runs the function entirely
 * in-process and does NOT model Inngest's own retry loop ("There are
 * currently no retries modelled; any step or function that fails once will
 * fail permanently" — `@inngest/test`'s README). A failing step's error
 * comes back from `t.execute()` as a JSON-safe plain object produced by
 * `inngest`'s own `serializeError` (`helpers/errors.js`, confirmed against
 * `inngest@4.20.0`), NOT the original `RetryAfterError`/`NonRetriableError`
 * instance — `instanceof` checks against it are always false, and only
 * `name`, `message`, `stack`, `code`, and `cause` survive (recursively) the
 * serialization; custom fields such as `RetryAfterError.retryAfter` or
 * `WorkflowStepFailedError.stepName`/`.reason` do NOT survive. This is why
 * the assertions below match on `.name` and on the `reason` string embedded
 * in `.message`/the nested `.cause.message`, rather than on `instanceof` or
 * on `.cause.reason` directly.
 */

function eventPayload(
  overrides?: Partial<{
    amount: number;
    currency: string;
    paymentMethodToken: string;
    merchantId: string;
  }>,
): { name: string; data: unknown } {
  return {
    name: "payment/execute.requested",
    data: paymentExecuteRequestedSchema.parse({
      amount: 1000,
      currency: "USD",
      paymentMethodToken: "tok_visa",
      merchantId: "merchant-1",
      ...overrides,
    }),
  };
}

function buildEngine(deps: {
  payCore: FakePayCoreClient;
  ledger: InMemoryLedgerRepository;
  overrides?: Partial<{
    amount: number;
    currency: string;
    paymentMethodToken: string;
    merchantId: string;
  }>;
  transformCtx?: (ctx: unknown) => unknown;
}): InngestTestEngine {
  const inngest = new Inngest({ id: "durable-ledger-test" });
  const fn = createPaymentExecuteFunction({
    inngest,
    payCore: deps.payCore,
    ledger: deps.ledger,
  });
  return new InngestTestEngine({
    function: fn,
    events: [eventPayload(deps.overrides)],
    ...(deps.transformCtx ? { transformCtx: deps.transformCtx as never } : {}),
  });
}

describe("payment.execute workflow", () => {
  it("happy path: authorizes, captures, posts a balanced ledger entry, in order", async () => {
    const payCore = new FakePayCoreClient();
    const authResponse = authorizedPaymentResponse();
    payCore.scriptCreatePayment({ kind: "resolve", response: authResponse });
    payCore.scriptCapturePayment({
      kind: "resolve",
      response: capturedPaymentResponse(authResponse.id, {
        capturedAmount: 1000,
        currency: "USD",
      }),
    });
    const ledger = new InMemoryLedgerRepository();
    const t = buildEngine({ payCore, ledger });

    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    const output = result as PaymentExecuteResult;
    expect(output).toMatchObject({
      paymentId: authResponse.id,
      status: "captured",
      currency: "USD",
      capturedAmount: 1000,
      ledgerOutcome: "posted",
    });
    expect(typeof output.ledgerOperationId).toBe("string");

    expect(payCore.calls.map((c) => c.method)).toEqual([
      "create_payment",
      "capture_payment",
    ]);

    const entries = await ledger.findByOperationId(output.ledgerOperationId);
    expect(entries).toHaveLength(2);
    const clearing = await ledger.getBalance(
      LedgerAccount.acquirerClearing(),
      "USD",
    );
    const merchant = await ledger.getBalance(
      LedgerAccount.merchant("merchant-1"),
      "USD",
    );
    expect(clearing.amount).toBe(-1000);
    expect(merchant.amount).toBe(1000);
    expect(
      balanceOf(entries, LedgerAccount.acquirerClearing(), "USD").amount +
        balanceOf(entries, LedgerAccount.merchant("merchant-1"), "USD").amount,
    ).toBe(0);
  });

  it("sends different Idempotency-Keys for authorize and capture, each matching stepIdempotencyKey(runId, stepName)", async () => {
    const payCore = new FakePayCoreClient();
    const authResponse = authorizedPaymentResponse();
    payCore.scriptCreatePayment({ kind: "resolve", response: authResponse });
    payCore.scriptCapturePayment({
      kind: "resolve",
      response: capturedPaymentResponse(authResponse.id),
    });
    const ledger = new InMemoryLedgerRepository();
    // `InngestTestEngine`'s default (non-pinned) `runId` is freshly minted
    // on every internal re-invocation of the handler as steps are
    // discovered/fulfilled (confirmed empirically against
    // `@inngest/test@1.0.0`'s `individualExecution`, which calls
    // `ulid()` per call) — so without pinning it, the key actually SENT for
    // an earlier step (from an earlier pass) can legitimately differ from
    // the final `ctx.runId` this test would otherwise compare it to. Pin it
    // via `transformCtx` so every pass — and thus every step — sees the
    // same `runId`, matching real Inngest's guarantee that `runId` is
    // stable for the lifetime of one logical run.
    const fixedRunId = "fixed-run-id-for-key-test";
    const t = buildEngine({
      payCore,
      ledger,
      transformCtx: (ctx) => ({ ...(ctx as object), runId: fixedRunId }),
    });

    const { error } = await t.execute();
    expect(error).toBeUndefined();

    const [authorizeCall, captureCall] = payCore.calls;
    expect(authorizeCall?.idempotencyKey).toBe(
      stepIdempotencyKey(fixedRunId, "authorize"),
    );
    expect(captureCall?.idempotencyKey).toBe(
      stepIdempotencyKey(fixedRunId, "capture"),
    );
    expect(authorizeCall?.idempotencyKey).not.toBe(captureCall?.idempotencyKey);
  });

  it("a 503 PayCoreUnavailableError on capture surfaces as a RetryAfterError-shaped failure; capture called once; ledger untouched", async () => {
    const payCore = new FakePayCoreClient();
    const authResponse = authorizedPaymentResponse();
    payCore.scriptCreatePayment({ kind: "resolve", response: authResponse });
    payCore.scriptCapturePayment({
      kind: "reject",
      error: new PayCoreUnavailableError("pay-core unavailable", {
        operation: "capture_payment",
        status: 503,
        payCoreCode: "unavailable",
      }),
    });
    const ledger = new InMemoryLedgerRepository();
    const t = buildEngine({ payCore, ledger });

    const { error } = await t.execute();

    expect((error as { name?: string } | undefined)?.name).toBe(
      "RetryAfterError",
    );
    expect(payCore.calls.map((c) => c.method)).toEqual([
      "create_payment",
      "capture_payment",
    ]);
    expect(await ledger.findByPaymentId(authResponse.id)).toHaveLength(0);
  });

  it("honors a server retryAfterMs hint on the capture failure (quantized to whole seconds by RetryAfterError, per rethrowForInngest's own unit test)", async () => {
    const payCore = new FakePayCoreClient();
    const authResponse = authorizedPaymentResponse();
    payCore.scriptCreatePayment({ kind: "resolve", response: authResponse });
    payCore.scriptCapturePayment({
      kind: "reject",
      error: new PayCoreUnavailableError(
        "pay-core unavailable",
        {
          operation: "capture_payment",
          status: 503,
          payCoreCode: "unavailable",
        },
        5000,
      ),
    });
    const ledger = new InMemoryLedgerRepository();
    const t = buildEngine({ payCore, ledger });

    const { error } = await t.execute();

    // `@inngest/test` strips RetryAfterError's own `retryAfter` field during
    // serialization (see the module header) — this test can only pin the
    // shape and that capture was attempted exactly once with nothing posted;
    // the "5000ms -> '5'" quantization itself is pinned directly against the
    // real `RetryAfterError` instance in `inngest-errors.test.ts`.
    expect((error as { name?: string } | undefined)?.name).toBe(
      "RetryAfterError",
    );
    expect(payCore.calls.map((c) => c.method)).toEqual([
      "create_payment",
      "capture_payment",
    ]);
    expect(await ledger.findByPaymentId(authResponse.id)).toHaveLength(0);
  });

  it("a 402 PayCoreDeclinedError on capture surfaces as a NonRetriableError-shaped failure; ledger untouched", async () => {
    const payCore = new FakePayCoreClient();
    const authResponse = authorizedPaymentResponse();
    payCore.scriptCreatePayment({ kind: "resolve", response: authResponse });
    payCore.scriptCapturePayment({
      kind: "reject",
      error: new PayCoreDeclinedError("declined", {
        operation: "capture_payment",
        status: 402,
        payCoreCode: "declined",
      }),
    });
    const ledger = new InMemoryLedgerRepository();
    const t = buildEngine({ payCore, ledger });

    const { error } = await t.execute();

    const failure = error as { name?: string; message?: string } | undefined;
    expect(failure?.name).toBe("NonRetriableError");
    expect(failure?.message).toContain("terminal_error");
    expect(await ledger.findByPaymentId(authResponse.id)).toHaveLength(0);
  });

  it("a 201-with-status:failed authorize response fails cleanly and never calls capture; ledger untouched", async () => {
    const payCore = new FakePayCoreClient();
    const declined = declinedAtAuthorizeResponse();
    payCore.scriptCreatePayment({ kind: "resolve", response: declined });
    const ledger = new InMemoryLedgerRepository();
    const t = buildEngine({ payCore, ledger });

    const { error } = await t.execute();

    const failure = error as { name?: string; message?: string } | undefined;
    expect(failure?.name).toBe("NonRetriableError");
    expect(failure?.message).toContain("failed to authorize");
    expect(payCore.calls.map((c) => c.method)).toEqual(["create_payment"]);
    expect(await ledger.findByPaymentId(declined.id)).toHaveLength(0);
  });

  it("attempts-exhausted is distinguishable from terminal_error", async () => {
    const payCore = new FakePayCoreClient();
    const authResponse = authorizedPaymentResponse();
    payCore.scriptCreatePayment({ kind: "resolve", response: authResponse });
    payCore.scriptCapturePayment({
      kind: "reject",
      error: new PayCoreUnavailableError("pay-core unavailable", {
        operation: "capture_payment",
        status: 503,
        payCoreCode: "unavailable",
      }),
    });
    const ledger = new InMemoryLedgerRepository();
    const t = buildEngine({
      payCore,
      ledger,
      transformCtx: (ctx) => ({
        ...(ctx as object),
        attempt: DEFAULT_RETRY_POLICY.maxAttempts - 1, // ctx.attempt is 0-indexed; this is the last attempt before exhaustion
      }),
    });

    const { error } = await t.execute();

    const failure = error as { name?: string; message?: string } | undefined;
    expect(failure?.name).toBe("NonRetriableError");
    expect(failure?.message).toContain("attempts_exhausted");
    expect(failure?.message).not.toContain("terminal_error");
  });

  it("exactly-once resume-after-crash: a pre-seeded authorize step is never re-run, and capture proceeds using the memoized result", async () => {
    const payCore = new FakePayCoreClient();
    const authResponse = authorizedPaymentResponse();
    payCore.scriptCapturePayment({
      kind: "resolve",
      response: capturedPaymentResponse(authResponse.id, {
        capturedAmount: 1000,
        currency: "USD",
      }),
    });
    const ledger = new InMemoryLedgerRepository();
    const inngest = new Inngest({ id: "durable-ledger-test-resume" });
    const fn = createPaymentExecuteFunction({ inngest, payCore, ledger });
    const t = new InngestTestEngine({
      function: fn,
      events: [eventPayload()],
      steps: [{ id: "authorize", handler: () => authResponse }],
    });

    const { error, result } = await t.execute();

    expect(error).toBeUndefined();
    expect((result as PaymentExecuteResult).paymentId).toBe(authResponse.id);
    expect(payCore.calls.map((c) => c.method)).toEqual(["capture_payment"]);
  });

  it("idempotent re-execution with the same runId: the second run's post-ledger returns already_posted without doubling entries", async () => {
    const payCore = new FakePayCoreClient();
    const authResponse = authorizedPaymentResponse();
    const capture = capturedPaymentResponse(authResponse.id, {
      capturedAmount: 1000,
      currency: "USD",
    });
    payCore.scriptCreatePayment({ kind: "resolve", response: authResponse });
    payCore.scriptCapturePayment({ kind: "resolve", response: capture });
    payCore.scriptCreatePayment({ kind: "resolve", response: authResponse });
    payCore.scriptCapturePayment({ kind: "resolve", response: capture });
    const ledger = new InMemoryLedgerRepository();
    const inngest = new Inngest({ id: "durable-ledger-test-idempotent" });
    const fn = createPaymentExecuteFunction({ inngest, payCore, ledger });
    const fixedRunId = "fixed-run-id-for-idempotency-test";
    // Two SEPARATE `InngestTestEngine` instances (not two `.execute()` calls
    // on one instance): `InngestTestEngine`'s own `mockHandlerCache`
    // persists across `.execute()` calls made on the SAME instance, which
    // would mask a genuine second `post-ledger` invocation behind a stale
    // cached step result — an artifact of the test engine, not of
    // `payment.execute` itself (confirmed by the "posted" -> "already_posted"
    // sequence appearing correctly once each run gets its own engine, and by
    // the ledger's own entry count, asserted below, either way).
    const engineFor = () =>
      new InngestTestEngine({
        function: fn,
        events: [eventPayload()],
        transformCtx: (ctx) => ({ ...ctx, runId: fixedRunId }),
      });

    const first = await engineFor().execute();
    const second = await engineFor().execute();

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    const firstOutput = first.result as PaymentExecuteResult;
    const secondOutput = second.result as PaymentExecuteResult;
    expect(firstOutput.ledgerOutcome).toBe("posted");
    expect(secondOutput.ledgerOutcome).toBe("already_posted");
    expect(secondOutput.ledgerOperationId).toBe(firstOutput.ledgerOperationId);

    const entries = await ledger.findByOperationId(
      firstOutput.ledgerOperationId,
    );
    expect(entries).toHaveLength(2); // not doubled
  });

  it("a PostingConflictError from the ledger during post-ledger fails with NonRetriableError, reason unclassified_error", async () => {
    const payCore = new FakePayCoreClient();
    const authResponse = authorizedPaymentResponse();
    payCore.scriptCreatePayment({ kind: "resolve", response: authResponse });
    payCore.scriptCapturePayment({
      kind: "resolve",
      response: capturedPaymentResponse(authResponse.id, {
        capturedAmount: 1000,
        currency: "USD",
      }),
    });
    const ledger = new InMemoryLedgerRepository();
    vi.spyOn(ledger, "post").mockRejectedValueOnce(
      new PostingConflictError("some-operation-id", "attempted", "stored"),
    );
    const t = buildEngine({ payCore, ledger });

    const { error } = await t.execute();

    const failure = error as { name?: string; message?: string } | undefined;
    expect(failure?.name).toBe("NonRetriableError");
    expect(failure?.message).toContain("unclassified_error");
  });
});
