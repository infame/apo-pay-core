import { createPool } from "./adapters/persistence/drizzle/db.js";
import { TransactionScope } from "./adapters/persistence/drizzle/transaction-scope.js";
import { PgPaymentRepository } from "./adapters/persistence/drizzle/pg-payment-repository.js";
import { PgIdempotencyStore } from "./adapters/persistence/drizzle/pg-idempotency-store.js";
import { DuplicateIdempotencyKeyError } from "./adapters/persistence/drizzle/errors.js";
import { InMemoryPaymentRepository } from "./adapters/memory/in-memory-payment-repository.js";
import { InMemoryIdempotencyStore } from "./adapters/memory/in-memory-idempotency-store.js";
import type { PaymentProvider } from "./ports/payment-provider.js";
import {
  CreatePayment,
  type CreatePaymentCommand,
  type CreatePaymentResult,
} from "./app/create-payment.js";
import {
  CapturePayment,
  type CapturePaymentCommand,
  type CapturePaymentResult,
} from "./app/capture-payment.js";
import {
  RefundPayment,
  type RefundPaymentCommand,
  type RefundPaymentResult,
} from "./app/refund-payment.js";
import {
  CancelPayment,
  type CancelPaymentCommand,
  type CancelPaymentResult,
} from "./app/cancel-payment.js";
import { GetPayment, type GetPaymentResult } from "./app/get-payment.js";

export interface CreatePayCoreOptions {
  readonly databaseUrl: string;
  readonly provider: PaymentProvider;
  readonly clock?: () => Date;
}

export interface PayCoreUseCases {
  readonly createPayment: (
    raw: CreatePaymentCommand,
  ) => Promise<CreatePaymentResult>;
  readonly capturePayment: (
    raw: CapturePaymentCommand,
  ) => Promise<CapturePaymentResult>;
  readonly refundPayment: (
    raw: RefundPaymentCommand,
  ) => Promise<RefundPaymentResult>;
  readonly cancelPayment: (
    raw: CancelPaymentCommand,
  ) => Promise<CancelPaymentResult>;
  readonly getPayment: (paymentId: string) => Promise<GetPaymentResult>;
}

export interface PayCore extends PayCoreUseCases {
  /** Closes the underlying connection pool. Call once on shutdown. */
  close: () => Promise<void>;
}

/**
 * Wires a mutating use-case's `execute` inside the ambient transaction scope,
 * and turns the "idempotency race lost" case into a replay instead of an
 * error.
 *
 * Both `PaymentRepository.save` and `IdempotencyStore.save` run inside the
 * *same* ambient transaction (it begins lazily on the first write — see
 * `TransactionScope`), so when two concurrent requests race on the same
 * idempotency key, the loser's `idempotencyKeys` insert hits the
 * `(key, operation)` primary key and throws `DuplicateIdempotencyKeyError`,
 * which rolls back that whole transaction — including the loser's payment
 * insert. There is no orphan row to clean up. We then re-read the winner's
 * already-committed record *outside* that rolled-back transaction (the
 * ambient scope has already ended by the time this `catch` runs) and return
 * its snapshot, so both callers observe the same single effect.
 */
function withIdempotencyReplay<Cmd extends { idempotencyKey: string }, Result>(
  scope: TransactionScope,
  store: PgIdempotencyStore,
  execute: (raw: Cmd) => Promise<Result>,
): (raw: Cmd) => Promise<Result> {
  return async (raw: Cmd) => {
    try {
      return await scope.run(() => execute(raw));
    } catch (err) {
      if (err instanceof DuplicateIdempotencyKeyError) {
        const winner = await store.find(raw.idempotencyKey);
        if (winner) {
          return winner.response as Result;
        }
      }
      throw err;
    }
  };
}

/**
 * Builds a ready-to-use payment core against a real Postgres database: the
 * five use-cases wired to the Drizzle/Postgres adapters, with the ambient
 * transaction scope and idempotency-race handling described above. `close()`
 * must be called on shutdown to release the connection pool.
 */
export function createPayCore(options: CreatePayCoreOptions): PayCore {
  const pool = createPool(options.databaseUrl);
  const scope = new TransactionScope(pool);
  const repo = new PgPaymentRepository(scope);
  const clock = options.clock ?? (() => new Date());

  const createStore = new PgIdempotencyStore(scope, "create_payment");
  const captureStore = new PgIdempotencyStore(scope, "capture_payment");
  const refundStore = new PgIdempotencyStore(scope, "refund_payment");
  const cancelStore = new PgIdempotencyStore(scope, "cancel_payment");

  const createUseCase = new CreatePayment(
    repo,
    options.provider,
    createStore,
    clock,
  );
  const captureUseCase = new CapturePayment(
    repo,
    options.provider,
    captureStore,
    clock,
  );
  const refundUseCase = new RefundPayment(
    repo,
    options.provider,
    refundStore,
    clock,
  );
  const cancelUseCase = new CancelPayment(
    repo,
    options.provider,
    cancelStore,
    clock,
  );
  const getUseCase = new GetPayment(repo);

  return {
    createPayment: withIdempotencyReplay(
      scope,
      createStore,
      (raw: CreatePaymentCommand) => createUseCase.execute(raw),
    ),
    capturePayment: withIdempotencyReplay(
      scope,
      captureStore,
      (raw: CapturePaymentCommand) => captureUseCase.execute(raw),
    ),
    refundPayment: withIdempotencyReplay(
      scope,
      refundStore,
      (raw: RefundPaymentCommand) => refundUseCase.execute(raw),
    ),
    cancelPayment: withIdempotencyReplay(
      scope,
      cancelStore,
      (raw: CancelPaymentCommand) => cancelUseCase.execute(raw),
    ),
    getPayment: (paymentId: string) => getUseCase.execute(paymentId),
    close: () => pool.end(),
  };
}

export interface CreateInMemoryPayCoreOptions {
  readonly provider: PaymentProvider;
  readonly clock?: () => Date;
}

/**
 * Builds a payment core against the in-memory adapters, for tests and local
 * demos — no database, no `close()`. Four separate `InMemoryIdempotencyStore`
 * instances (one per mutating use-case) mirror `PgIdempotencyStore`'s
 * `(key, operation)` uniqueness: the Postgres store scopes a key to its
 * operation, but `InMemoryIdempotencyStore` keys on `key` alone, so a single
 * shared instance would make a client that reuses the same `Idempotency-Key`
 * across two different operations (e.g. create then capture) incorrectly
 * receive the wrong operation's cached snapshot.
 *
 * `withIdempotencyReplay` is Postgres-specific (it recovers from a unique-
 * constraint race on a shared transaction) and doesn't apply here: the
 * in-memory store is single-threaded and has no such race to replay from, so
 * the five use-cases are wired directly against the in-memory adapters.
 *
 * The repository is returned on the result object so tests can assert "no
 * second effect happened" by inspecting `repository.outbox`.
 */
export function createInMemoryPayCore(
  options: CreateInMemoryPayCoreOptions,
): PayCoreUseCases & { readonly repository: InMemoryPaymentRepository } {
  const repo = new InMemoryPaymentRepository();
  const clock = options.clock ?? (() => new Date());

  const createStore = new InMemoryIdempotencyStore();
  const captureStore = new InMemoryIdempotencyStore();
  const refundStore = new InMemoryIdempotencyStore();
  const cancelStore = new InMemoryIdempotencyStore();

  const createUseCase = new CreatePayment(
    repo,
    options.provider,
    createStore,
    clock,
  );
  const captureUseCase = new CapturePayment(
    repo,
    options.provider,
    captureStore,
    clock,
  );
  const refundUseCase = new RefundPayment(
    repo,
    options.provider,
    refundStore,
    clock,
  );
  const cancelUseCase = new CancelPayment(
    repo,
    options.provider,
    cancelStore,
    clock,
  );
  const getUseCase = new GetPayment(repo);

  return {
    createPayment: (raw: CreatePaymentCommand) => createUseCase.execute(raw),
    capturePayment: (raw: CapturePaymentCommand) => captureUseCase.execute(raw),
    refundPayment: (raw: RefundPaymentCommand) => refundUseCase.execute(raw),
    cancelPayment: (raw: CancelPaymentCommand) => cancelUseCase.execute(raw),
    getPayment: (paymentId: string) => getUseCase.execute(paymentId),
    repository: repo,
  };
}
