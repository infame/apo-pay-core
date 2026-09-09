import { and, eq } from "drizzle-orm";
import { Payment } from "../../../domain/payment.js";
import type { DomainEvent } from "../../../domain/events.js";
import type { PaymentRepository } from "../../../ports/payment-repository.js";
import { paymentEvents, payments } from "./schema.js";
import { eventToRow, paymentToRow, rowToPayment } from "./mappers.js";
import { OptimisticLockError } from "./errors.js";
import type { TransactionScope } from "./transaction-scope.js";

/**
 * Postgres/Drizzle implementation of `PaymentRepository`.
 *
 * Concurrency: mutations are optimistic-locked on `payments.version`
 * (`UPDATE … WHERE id = $1 AND version = $2`, throwing `OptimisticLockError`
 * when zero rows come back), not `SELECT … FOR UPDATE`. A row lock held
 * across the external PSP call (the whole point of the auth/capture/refund
 * flow) would pin a pooled connection for as long as the provider takes to
 * respond, which under a slow/degraded provider would exhaust the pool for
 * every other request. Optimistic locking only pays a cost on genuine
 * write-write conflicts, which are rare for a single payment. See the
 * README's "Persistence & concurrency" section.
 *
 * Version tracking uses a `WeakMap<Payment, number>` keyed by the *aggregate
 * instance* returned from `findById`, not by payment id. Keying by id would
 * let a second, independently-loaded `Payment` instance for the same id
 * "re-arm" the tracked version and silently overwrite a concurrent writer's
 * update instead of losing the optimistic-lock race as it should.
 */
export class PgPaymentRepository implements PaymentRepository {
  private readonly versions = new WeakMap<Payment, number>();

  constructor(private readonly scope: TransactionScope) {}

  async findById(id: string): Promise<Payment | null> {
    const db = this.scope.current();
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    const payment = rowToPayment(row);
    this.versions.set(payment, row.version);
    return payment;
  }

  async save(payment: Payment, events: DomainEvent[]): Promise<void> {
    const db = await this.scope.beginIfNeeded();
    const knownVersion = this.versions.get(payment);

    let newVersion: number;
    if (knownVersion === undefined) {
      newVersion = 1;
      await db.insert(payments).values(paymentToRow(payment, newVersion));
    } else {
      newVersion = knownVersion + 1;
      const row = paymentToRow(payment, newVersion);
      const updated = await db
        .update(payments)
        .set({
          status: row.status,
          currency: row.currency,
          amountAuthorized: row.amountAuthorized,
          amountCaptured: row.amountCaptured,
          amountRefunded: row.amountRefunded,
          providerRef: row.providerRef,
          failureReason: row.failureReason,
          version: newVersion,
          updatedAt: row.updatedAt,
        })
        .where(
          and(eq(payments.id, payment.id), eq(payments.version, knownVersion)),
        )
        .returning({ id: payments.id });
      if (updated.length === 0) {
        throw new OptimisticLockError(payment.id, knownVersion);
      }
    }

    if (events.length > 0) {
      await db.insert(paymentEvents).values(events.map(eventToRow));
    }

    this.versions.set(payment, newVersion);
  }
}
