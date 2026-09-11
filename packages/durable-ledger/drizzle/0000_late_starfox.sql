-- Hand-edited from drizzle-kit's generated `CREATE SCHEMA "ledger";`: with
-- `migrationsSchema: "ledger"` (migrator.ts), drizzle-orm's runtime already
-- runs `CREATE SCHEMA IF NOT EXISTS "ledger"` itself, on every `migrate()`
-- call, to hold the migration journal — before this migration's own
-- statements run. Without `IF NOT EXISTS` here too, that ordering makes this
-- statement fail with "schema already exists" the very first time
-- migrations are applied. IF NOT EXISTS keeps this idempotent either way.
CREATE SCHEMA IF NOT EXISTS "ledger";
--> statement-breakpoint
CREATE TABLE "ledger"."ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"account" text NOT NULL,
	"direction" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"payment_id" text NOT NULL,
	"entry_type" text NOT NULL,
	"reverses_operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_positive" CHECK ("ledger"."ledger_entries"."amount" > 0),
	CONSTRAINT "ledger_entries_direction_valid" CHECK ("ledger"."ledger_entries"."direction" IN ('debit','credit')),
	CONSTRAINT "ledger_entries_entry_type_valid" CHECK ("ledger"."ledger_entries"."entry_type" IN ('capture','refund','reversal')),
	CONSTRAINT "ledger_entries_currency_iso4217" CHECK ("ledger"."ledger_entries"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "ledger_entries_account_format" CHECK ("ledger"."ledger_entries"."account" = 'acquirer_clearing' OR "ledger"."ledger_entries"."account" ~ '^(customer|merchant):[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_operation_account_direction_uq" ON "ledger"."ledger_entries" USING btree ("operation_id","account","direction");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_currency_idx" ON "ledger"."ledger_entries" USING btree ("account","currency");--> statement-breakpoint
CREATE INDEX "ledger_entries_payment_id_idx" ON "ledger"."ledger_entries" USING btree ("payment_id");--> statement-breakpoint
-- Hand-written below this line: drizzle-kit doesn't model triggers, so this
-- block is never touched or reverted by a future `db:generate`. Enforces
-- append-only on `ledger.ledger_entries` (spec §7) — the ledger only ever
-- grows via INSERT; corrections are new reversal entries, never an UPDATE or
-- DELETE of an existing row. `TRUNCATE` bypasses row-level triggers, so
-- `test-support.ts`'s between-test cleanup is unaffected.
CREATE FUNCTION "ledger"."reject_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger.ledger_entries is append-only: % not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "ledger"."ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();