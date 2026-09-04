import { randomUUID } from "node:crypto";
import {
  ProviderDeclinedError,
  type AuthorizeParams,
  type AuthorizeResult,
  type CancelParams,
  type CaptureParams,
  type PaymentProvider,
  type RefundParams,
} from "../../ports/payment-provider.js";

/**
 * In-memory provider for local demos and tests — no real money moves.
 *
 * Deterministic decline hook: any authorize whose amount ends in `13` minor
 * units is declined, so tests and the demo can exercise the failure path
 * without special configuration.
 */
export class MockProvider implements PaymentProvider {
  readonly name = "mock";

  async authorize(params: AuthorizeParams): Promise<AuthorizeResult> {
    if (params.amount.amount % 100 === 13) {
      throw new ProviderDeclinedError("simulated decline", "card_declined");
    }
    return { providerRef: `mock_${randomUUID()}` };
  }

  async capture(_params: CaptureParams): Promise<void> {
    // no-op for the mock
  }

  async refund(_params: RefundParams): Promise<void> {
    // no-op for the mock
  }

  async cancel(_params: CancelParams): Promise<void> {
    // no-op for the mock
  }
}
