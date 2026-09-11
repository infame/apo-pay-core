import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Money } from "../../../domain/money.js";
import { LedgerAccount } from "../../../domain/account.js";
import { LedgerEntry, PostingGroup } from "../../../domain/entry.js";
import { assertZeroSum, balanceOf } from "../../../domain/balances.js";
import { ledgerEntries, type NewLedgerEntryRow } from "./schema.js";
import { withTestDb } from "./test-support.js";

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Real-Postgres suite hitting the raw Drizzle client directly — no
 * repository/port layer exists yet (that's step 3), so rows are built
 * inline from domain objects via `.toState()`. Skipped (not silently — see
 * `test-support.ts`) unless `TEST_DATABASE_URL` is set; `pnpm test` never
 * picks this file up at all (`vitest.config.ts` excludes
 * `*.integration.test.ts`), so this guard only matters for a
 * direct/misconfigured invocation.
 */
describe.skipIf(!hasTestDb)(
  "ledger.ledger_entries schema (integration)",
  () => {
    if (!hasTestDb) return;

    const { db } = withTestDb();

    /** `LedgerEntry.toState()` -> a row shape the schema accepts, splitting `Money` into `amount`+`currency`. */
    function toRow(entry: LedgerEntry): NewLedgerEntryRow {
      const state = entry.toState();
      return {
        id: state.id,
        operationId: state.operationId,
        account: state.account.toString(),
        direction: state.direction,
        amount: state.amount.amount,
        currency: state.amount.currency,
        paymentId: state.paymentId,
        entryType: state.entryType,
        reversesOperationId: state.reversesOperationId,
        createdAt: state.createdAt,
      };
    }

    /** A syntactically-valid row, overridable per test — used to probe one column's CHECK in isolation. */
    function baseRow(
      overrides: Partial<NewLedgerEntryRow> = {},
    ): NewLedgerEntryRow {
      return {
        id: randomUUID(),
        operationId: randomUUID(),
        account: "merchant:abc",
        direction: "debit",
        amount: 100,
        currency: "USD",
        paymentId: "pay_1",
        entryType: "capture",
        reversesOperationId: null,
        ...overrides,
      };
    }

    /**
     * drizzle-orm (0.45.x, node-postgres driver) wraps the raw `pg` error in
     * its own `DrizzleQueryError`, with the original error — the one that
     * actually has `.code`/`.constraint` — on `.cause`. Mirrors
     * `packages/pay-core/src/adapters/persistence/drizzle/errors.ts`'s
     * `pgErrorOf` unwrap.
     */
    function pgErrorOf(
      err: unknown,
    ): { code?: string; constraint?: string; message?: string } | undefined {
      if (typeof err !== "object" || err === null || !("cause" in err)) {
        return undefined;
      }
      const cause = (err as { cause?: unknown }).cause;
      if (typeof cause !== "object" || cause === null) {
        return undefined;
      }
      return cause;
    }

    async function expectConstraintViolation(
      promise: Promise<unknown>,
      constraint: string,
    ): Promise<void> {
      await expect(promise).rejects.toSatisfy(
        (err: unknown) => pgErrorOf(err)?.constraint === constraint,
      );
    }

    async function expectAppendOnlyRejection(
      promise: Promise<unknown>,
    ): Promise<void> {
      await expect(promise).rejects.toSatisfy((err: unknown) =>
        Boolean(pgErrorOf(err)?.message?.includes("append-only")),
      );
    }

    describe("round-trip", () => {
      it("preserves all nine LedgerEntryProps fields through insert + select", async () => {
        const group = PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId: "pay_roundtrip",
          merchantId: "acme",
          amount: Money.of(1500, "USD"),
        });

        await db.insert(ledgerEntries).values(group.entries.map(toRow));

        const rows = await db
          .select()
          .from(ledgerEntries)
          .where(eq(ledgerEntries.operationId, group.operationId));
        expect(rows).toHaveLength(2);

        for (const entry of group.entries) {
          const row = rows.find((r) => r.id === entry.id);
          expect(row).toBeDefined();
          expect(row?.operationId).toBe(entry.operationId);
          expect(row?.account).toBe(entry.account.toString());
          expect(row?.direction).toBe(entry.direction);
          expect(row?.amount).toBe(entry.amount.amount);
          expect(row?.currency).toBe(entry.amount.currency);
          expect(row?.paymentId).toBe(entry.paymentId);
          expect(row?.entryType).toBe(entry.entryType);
          expect(row?.reversesOperationId).toBeNull();
          expect(row?.createdAt).toBeInstanceOf(Date);
        }
      });

      it("rehydrates Money + LedgerAccount losslessly so balanceOf matches the in-memory group", async () => {
        const group = PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId: "pay_rehydrate",
          merchantId: "acme",
          amount: Money.of(750, "EUR"),
        });
        await db.insert(ledgerEntries).values(group.entries.map(toRow));

        const rows = await db
          .select()
          .from(ledgerEntries)
          .where(eq(ledgerEntries.operationId, group.operationId));

        const rehydrated = rows.map((row) =>
          LedgerEntry.fromState({
            id: row.id,
            operationId: row.operationId,
            account: LedgerAccount.parse(row.account),
            direction: row.direction as "debit" | "credit",
            amount: Money.of(row.amount, row.currency),
            paymentId: row.paymentId,
            entryType: row.entryType as "capture" | "refund" | "reversal",
            reversesOperationId: row.reversesOperationId,
            createdAt: row.createdAt,
          }),
        );

        const merchantAccount = LedgerAccount.merchant("acme");
        expect(
          balanceOf(rehydrated, merchantAccount, "EUR").equals(
            balanceOf(group.entries, merchantAccount, "EUR"),
          ),
        ).toBe(true);
        expect(
          balanceOf(rehydrated, merchantAccount, "EUR").equals(
            Money.of(750, "EUR"),
          ),
        ).toBe(true);
      });

      it("a capture group and a matching refund group both round-trip and net to zero", async () => {
        const operationId1 = randomUUID();
        const operationId2 = randomUUID();
        const capture = PostingGroup.forCapture({
          operationId: operationId1,
          paymentId: "pay_zero_sum",
          merchantId: "acme",
          amount: Money.of(2000, "USD"),
        });
        const refund = PostingGroup.forRefund({
          operationId: operationId2,
          paymentId: "pay_zero_sum",
          merchantId: "acme",
          amount: Money.of(2000, "USD"),
        });

        await db
          .insert(ledgerEntries)
          .values([
            ...capture.entries.map(toRow),
            ...refund.entries.map(toRow),
          ]);

        const rows = await db
          .select()
          .from(ledgerEntries)
          .where(
            or(
              eq(ledgerEntries.operationId, operationId1),
              eq(ledgerEntries.operationId, operationId2),
            ),
          );
        expect(rows).toHaveLength(4);

        const rehydrated = rows.map((row) =>
          LedgerEntry.fromState({
            id: row.id,
            operationId: row.operationId,
            account: LedgerAccount.parse(row.account),
            direction: row.direction as "debit" | "credit",
            amount: Money.of(row.amount, row.currency),
            paymentId: row.paymentId,
            entryType: row.entryType as "capture" | "refund" | "reversal",
            reversesOperationId: row.reversesOperationId,
            createdAt: row.createdAt,
          }),
        );

        expect(() => assertZeroSum(rehydrated)).not.toThrow();
      });
    });

    describe("DB constraints reject what they should", () => {
      it("rejects amount <= 0 (ledger_entries_amount_positive)", async () => {
        await expectConstraintViolation(
          db.insert(ledgerEntries).values(baseRow({ amount: 0 })),
          "ledger_entries_amount_positive",
        );
        await expectConstraintViolation(
          db.insert(ledgerEntries).values(baseRow({ amount: -1 })),
          "ledger_entries_amount_positive",
        );
      });

      it("rejects a direction outside ('debit','credit') (ledger_entries_direction_valid)", async () => {
        await expectConstraintViolation(
          db.insert(ledgerEntries).values(baseRow({ direction: "DEBIT" })),
          "ledger_entries_direction_valid",
        );
        await expectConstraintViolation(
          db.insert(ledgerEntries).values(baseRow({ direction: "transfer" })),
          "ledger_entries_direction_valid",
        );
      });

      it("rejects an entry_type outside ('capture','refund','reversal') (ledger_entries_entry_type_valid)", async () => {
        await expectConstraintViolation(
          db.insert(ledgerEntries).values(baseRow({ entryType: "chargeback" })),
          "ledger_entries_entry_type_valid",
        );
      });

      it("rejects a non-ISO-4217 currency (ledger_entries_currency_iso4217)", async () => {
        await expectConstraintViolation(
          db.insert(ledgerEntries).values(baseRow({ currency: "usd" })),
          "ledger_entries_currency_iso4217",
        );
        await expectConstraintViolation(
          db.insert(ledgerEntries).values(baseRow({ currency: "US" })),
          "ledger_entries_currency_iso4217",
        );
      });

      it("rejects a malformed account (ledger_entries_account_format)", async () => {
        await expectConstraintViolation(
          db.insert(ledgerEntries).values(baseRow({ account: "merchant:" })),
          "ledger_entries_account_format",
        );
        await expectConstraintViolation(
          db.insert(ledgerEntries).values(baseRow({ account: "bank:42" })),
          "ledger_entries_account_format",
        );
      });

      it("accepts acquirer_clearing and a well-formed merchant subject (positive control)", async () => {
        const clearingRow = baseRow({ account: "acquirer_clearing" });
        const merchantRow = baseRow({ account: "merchant:abc-1_2" });
        await db.insert(ledgerEntries).values([clearingRow, merchantRow]);

        const rows = await db
          .select()
          .from(ledgerEntries)
          .where(
            or(
              eq(ledgerEntries.id, clearingRow.id),
              eq(ledgerEntries.id, merchantRow.id),
            ),
          );
        expect(rows).toHaveLength(2);
      });

      it(
        "rejects re-posting the same operationId a second time (ledger_entries_operation_account_direction_uq) " +
          "— step 3 will turn this into an 'already posted, return the existing result' idempotency fast path, not a real error",
        async () => {
          const operationId = randomUUID();
          const first = PostingGroup.forCapture({
            operationId,
            paymentId: "pay_idem",
            merchantId: "acme",
            amount: Money.of(500, "USD"),
          });
          await db.insert(ledgerEntries).values(first.entries.map(toRow));

          const second = PostingGroup.forCapture({
            operationId,
            paymentId: "pay_idem",
            merchantId: "acme",
            amount: Money.of(500, "USD"),
          });
          await expectConstraintViolation(
            db.insert(ledgerEntries).values(second.entries.map(toRow)),
            "ledger_entries_operation_account_direction_uq",
          );
        },
      );

      it(
        "accepts two entries in the SAME group sharing an operationId but different (account, direction) " +
          "pairs (positive control — guards against narrowing the unique index to just UNIQUE(operation_id))",
        async () => {
          const group = PostingGroup.forCapture({
            operationId: randomUUID(),
            paymentId: "pay_group_ok",
            merchantId: "acme",
            amount: Money.of(100, "USD"),
          });
          await db.insert(ledgerEntries).values(group.entries.map(toRow));

          const rows = await db
            .select()
            .from(ledgerEntries)
            .where(eq(ledgerEntries.operationId, group.operationId));
          expect(rows).toHaveLength(2);
        },
      );
    });

    describe("append-only enforcement", () => {
      it("rejects UPDATE on an existing row", async () => {
        const row = baseRow();
        await db.insert(ledgerEntries).values(row);

        await expectAppendOnlyRejection(
          db
            .update(ledgerEntries)
            .set({ amount: 999 })
            .where(eq(ledgerEntries.id, row.id)),
        );
      });

      it("rejects DELETE of an existing row", async () => {
        const row = baseRow();
        await db.insert(ledgerEntries).values(row);

        await expectAppendOnlyRejection(
          db.delete(ledgerEntries).where(eq(ledgerEntries.id, row.id)),
        );
      });
    });

    describe("query paths", () => {
      it(
        "filtering by (account, currency) returns only matching rows, and acquirer_clearing runs " +
          "negative after a capture (the sign that gets 'fixed' by mistake)",
        async () => {
          const group = PostingGroup.forCapture({
            operationId: randomUUID(),
            paymentId: "pay_query_1",
            merchantId: "acme",
            amount: Money.of(300, "USD"),
          });
          const otherCurrencyGroup = PostingGroup.forCapture({
            operationId: randomUUID(),
            paymentId: "pay_query_1",
            merchantId: "other",
            amount: Money.of(300, "EUR"),
          });
          await db
            .insert(ledgerEntries)
            .values([
              ...group.entries.map(toRow),
              ...otherCurrencyGroup.entries.map(toRow),
            ]);

          const merchantAccount = LedgerAccount.merchant("acme");
          const scoped = await db
            .select()
            .from(ledgerEntries)
            .where(
              and(
                eq(ledgerEntries.account, merchantAccount.toString()),
                eq(ledgerEntries.currency, "USD"),
              ),
            );
          expect(scoped).toHaveLength(1);

          const rehydrated = scoped.map((row) =>
            LedgerEntry.fromState({
              id: row.id,
              operationId: row.operationId,
              account: LedgerAccount.parse(row.account),
              direction: row.direction as "debit" | "credit",
              amount: Money.of(row.amount, row.currency),
              paymentId: row.paymentId,
              entryType: row.entryType as "capture" | "refund" | "reversal",
              reversesOperationId: row.reversesOperationId,
              createdAt: row.createdAt,
            }),
          );
          expect(
            balanceOf(rehydrated, merchantAccount, "USD").equals(
              Money.of(300, "USD"),
            ),
          ).toBe(true);

          const acquirerForThisOp = await db
            .select()
            .from(ledgerEntries)
            .where(
              and(
                eq(ledgerEntries.account, "acquirer_clearing"),
                eq(ledgerEntries.operationId, group.operationId),
              ),
            );
          const rehydratedAcquirer = acquirerForThisOp.map((row) =>
            LedgerEntry.fromState({
              id: row.id,
              operationId: row.operationId,
              account: LedgerAccount.parse(row.account),
              direction: row.direction as "debit" | "credit",
              amount: Money.of(row.amount, row.currency),
              paymentId: row.paymentId,
              entryType: row.entryType as "capture" | "refund" | "reversal",
              reversesOperationId: row.reversesOperationId,
              createdAt: row.createdAt,
            }),
          );
          expect(
            balanceOf(
              rehydratedAcquirer,
              LedgerAccount.acquirerClearing(),
              "USD",
            ).equals(Money.of(-300, "USD")),
          ).toBe(true);
        },
      );

      it("filtering by paymentId returns entries across multiple operationIds", async () => {
        const paymentId = "pay_query_2";
        const capture = PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId,
          merchantId: "acme",
          amount: Money.of(400, "USD"),
        });
        const refund = PostingGroup.forRefund({
          operationId: randomUUID(),
          paymentId,
          merchantId: "acme",
          amount: Money.of(100, "USD"),
        });
        const unrelated = PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId: "pay_other",
          merchantId: "acme",
          amount: Money.of(999, "USD"),
        });

        await db
          .insert(ledgerEntries)
          .values([
            ...capture.entries.map(toRow),
            ...refund.entries.map(toRow),
            ...unrelated.entries.map(toRow),
          ]);

        const rows = await db
          .select()
          .from(ledgerEntries)
          .where(eq(ledgerEntries.paymentId, paymentId));
        expect(rows).toHaveLength(4);
        expect(new Set(rows.map((r) => r.operationId))).toEqual(
          new Set([capture.operationId, refund.operationId]),
        );
      });
    });
  },
);
