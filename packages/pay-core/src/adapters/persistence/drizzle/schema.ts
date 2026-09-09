import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Drizzle schema for the Postgres adapters. Column names follow the domain
 * (`status`, not `state`; see `docs/adr/0002-ports-and-adapters.md` and
 * `Payment.status`) since the code is the source of truth for the spec, not
 * the other way around.
 *
 * `failure_reason` is not in the original spec's column list — `PaymentProps`
 * carries `failureReason`, and omitting the column would silently drop it on
 * rehydration (`fromState`/`toState` round-trip), so it is added here.
 */

/**
 * Amount columns use `bigint(..., { mode: "number" })`. This maps to a JS
 * `number`, which loses precision above 2^53 - 1 minor units. `Money` already
 * enforces integer minor units at construction, and this ceiling (~90
 * trillion units of a currency) is far beyond what this system needs to
 * model; `mode: "bigint"` would avoid the ceiling but push a `bigint` through
 * every call site (JSON-unfriendly, and `Money.amount` is a plain `number`).
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey(),
    status: text("status").notNull(),
    currency: text("currency").notNull(),
    amountAuthorized: bigint("amount_authorized", { mode: "number" }).notNull(),
    amountCaptured: bigint("amount_captured", { mode: "number" })
      .notNull()
      .default(0),
    amountRefunded: bigint("amount_refunded", { mode: "number" })
      .notNull()
      .default(0),
    providerRef: text("provider_ref"),
    failureReason: text("failure_reason"),
    metadata: jsonb("metadata"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "payments_money_invariant",
      sql`${table.amountCaptured} - ${table.amountRefunded} >= 0
        AND ${table.amountCaptured} <= ${table.amountAuthorized}
        AND ${table.amountRefunded} >= 0`,
    ),
  ],
);

export type PaymentRow = typeof payments.$inferSelect;
export type NewPaymentRow = typeof payments.$inferInsert;

/**
 * Append-only outbox of domain events. `id` is the domain event's own id
 * (`DomainEvent.id`, minted by the aggregate at record time — see
 * `src/domain/events.ts` and ADR-0003's "events carry a stable id" property),
 * not one minted by the adapter.
 */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").primaryKey(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    index("payment_events_payment_id_occurred_at_idx").on(
      table.paymentId,
      table.occurredAt,
    ),
  ],
);

export type PaymentEventRow = typeof paymentEvents.$inferSelect;
export type NewPaymentEventRow = typeof paymentEvents.$inferInsert;

/**
 * `PRIMARY KEY (key, operation)` is the actual "exactly once" mechanism — the
 * uniqueness is enforced by the database, not by a check-then-insert in
 * application code (which would race).
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    paymentId: uuid("payment_id").references(() => payments.id),
    responseSnapshot: jsonb("response_snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.key, table.operation] })],
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKeyRow = typeof idempotencyKeys.$inferInsert;
