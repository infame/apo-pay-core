import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Money } from "../../../domain/money.js";
import { LedgerAccount } from "../../../domain/account.js";
import { PostingGroup } from "../../../domain/entry.js";
import { assertZeroSum, balanceOf } from "../../../domain/balances.js";
import { PostingConflictError } from "../../../ports/ledger-repository.js";
import { ledgerEntries } from "./schema.js";
import { PgLedgerRepository } from "./pg-ledger-repository.js";
import { withTestDb } from "./test-support.js";

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Real-Postgres suite for `PgLedgerRepository`. Skipped (not silently — see
 * `test-support.ts`) unless `TEST_DATABASE_URL` is set; `pnpm test` never
 * picks this file up at all (`vitest.config.ts` excludes
 * `*.integration.test.ts`), so this guard only matters for a
 * direct/misconfigured invocation.
 */
describe.skipIf(!hasTestDb)("PgLedgerRepository (integration)", () => {
  if (!hasTestDb) return;

  const { db } = withTestDb();
  const repo = new PgLedgerRepository(db);

  async function rowCount(operationId: string): Promise<number> {
    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.operationId, operationId));
    return rows.length;
  }

  describe("post + read back", () => {
    it("posts a forCapture group: outcome posted, 2 rows, findByOperationId matches fingerprint, reversesOperationId null", async () => {
      const operationId = randomUUID();
      const group = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_1",
        merchantId: "acme",
        amount: Money.of(1500, "USD"),
      });

      const result = await repo.post(group);
      expect(result.outcome).toBe("posted");
      expect(result.entries).toHaveLength(2);
      expect(await rowCount(operationId)).toBe(2);

      const found = await repo.findByOperationId(operationId);
      expect(found).toHaveLength(2);
      for (const entry of found) {
        expect(entry.operationId).toBe(operationId);
        expect(entry.paymentId).toBe("pay_1");
        expect(entry.entryType).toBe("capture");
        expect(entry.reversesOperationId).toBeNull();
      }
      const merchantEntry = found.find((e) =>
        e.account.equals(LedgerAccount.merchant("acme")),
      );
      expect(merchantEntry?.direction).toBe("credit");
      expect(merchantEntry?.amount.equals(Money.of(1500, "USD"))).toBe(true);
      const clearingEntry = found.find((e) =>
        e.account.equals(LedgerAccount.acquirerClearing()),
      );
      expect(clearingEntry?.direction).toBe("debit");
    });

    it("posts a forRefund group with entryType 'refund'", async () => {
      const operationId = randomUUID();
      const group = PostingGroup.forRefund({
        operationId,
        paymentId: "pay_2",
        merchantId: "acme",
        amount: Money.of(400, "USD"),
      });

      const result = await repo.post(group);
      expect(result.outcome).toBe("posted");

      const found = await repo.findByOperationId(operationId);
      expect(found).toHaveLength(2);
      for (const entry of found) {
        expect(entry.entryType).toBe("refund");
      }
    });

    it("round-trips reversesOperationId for a hand-built reversal-shaped group (PostingGroup.create directly)", async () => {
      const reversedOperationId = randomUUID();
      const operationId = randomUUID();
      const group = PostingGroup.create({
        operationId,
        paymentId: "pay_3",
        entryType: "reversal",
        reversesOperationId: reversedOperationId,
        entries: [
          {
            account: LedgerAccount.merchant("acme"),
            direction: "debit",
            amount: Money.of(200, "USD"),
          },
          {
            account: LedgerAccount.acquirerClearing(),
            direction: "credit",
            amount: Money.of(200, "USD"),
          },
        ],
      });

      await repo.post(group);
      const found = await repo.findByOperationId(operationId);
      expect(found).toHaveLength(2);
      for (const entry of found) {
        expect(entry.reversesOperationId).toBe(reversedOperationId);
      }
    });
  });

  describe("idempotency", () => {
    it("posting the same group object twice: second call is already_posted, still 2 rows, same ids", async () => {
      const operationId = randomUUID();
      const group = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_4",
        merchantId: "acme",
        amount: Money.of(600, "USD"),
      });

      const first = await repo.post(group);
      const second = await repo.post(group);

      expect(first.outcome).toBe("posted");
      expect(second.outcome).toBe("already_posted");
      expect(await rowCount(operationId)).toBe(2);
      expect(new Set(second.entries.map((e) => e.id))).toEqual(
        new Set(first.entries.map((e) => e.id)),
      );
    });

    it("posting two separately-constructed-but-equivalent groups: already_posted, 2 rows, ids are the FIRST call's", async () => {
      const operationId = randomUUID();
      const groupA = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_5",
        merchantId: "acme",
        amount: Money.of(700, "USD"),
        now: new Date("2024-01-01T00:00:00Z"),
      });
      const groupB = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_5",
        merchantId: "acme",
        amount: Money.of(700, "USD"),
        now: new Date("2024-06-01T00:00:00Z"),
      });

      const first = await repo.post(groupA);
      const second = await repo.post(groupB);

      expect(first.outcome).toBe("posted");
      expect(second.outcome).toBe("already_posted");
      expect(await rowCount(operationId)).toBe(2);
      expect(new Set(second.entries.map((e) => e.id))).toEqual(
        new Set(groupA.entries.map((e) => e.id)),
      );
    });

    it("concurrent post() of equivalent groups: exactly one posted + one already_posted, 2 rows total, no throw", async () => {
      const operationId = randomUUID();
      const groupA = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_6",
        merchantId: "acme",
        amount: Money.of(800, "USD"),
        now: new Date("2024-01-01T00:00:00Z"),
      });
      const groupB = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_6",
        merchantId: "acme",
        amount: Money.of(800, "USD"),
        now: new Date("2024-06-01T00:00:00Z"),
      });

      const [resultA, resultB] = await Promise.all([
        repo.post(groupA),
        repo.post(groupB),
      ]);

      const outcomes = [resultA.outcome, resultB.outcome].sort();
      expect(outcomes).toEqual(["already_posted", "posted"]);
      expect(await rowCount(operationId)).toBe(2);
    });
  });

  describe("conflict", () => {
    it("same operationId, different amount: PostingConflictError, row count unchanged", async () => {
      const operationId = randomUUID();
      const first = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_7",
        merchantId: "acme",
        amount: Money.of(900, "USD"),
      });
      const conflicting = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_7",
        merchantId: "acme",
        amount: Money.of(950, "USD"),
      });

      await repo.post(first);
      await expect(repo.post(conflicting)).rejects.toBeInstanceOf(
        PostingConflictError,
      );
      expect(await rowCount(operationId)).toBe(2);
    });

    it("same operationId, disjoint merchant accounts: PostingConflictError, row count still 2 not 4 (justifies the advisory lock)", async () => {
      const operationId = randomUUID();
      const first = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_8",
        merchantId: "acme",
        amount: Money.of(300, "USD"),
      });
      // Disjoint (account, direction) pairs from `first` — the unique index
      // on (operation_id, account, direction) alone would NOT catch this,
      // since none of these rows collide with `first`'s rows.
      const conflicting = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_8",
        merchantId: "other",
        amount: Money.of(300, "USD"),
      });

      await repo.post(first);
      await expect(repo.post(conflicting)).rejects.toBeInstanceOf(
        PostingConflictError,
      );
      expect(await rowCount(operationId)).toBe(2);
    });

    it("same operationId, forCapture then forRefund (different entryType): PostingConflictError", async () => {
      const operationId = randomUUID();
      const capture = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_9",
        merchantId: "acme",
        amount: Money.of(300, "USD"),
      });
      const refund = PostingGroup.forRefund({
        operationId,
        paymentId: "pay_9",
        merchantId: "acme",
        amount: Money.of(300, "USD"),
      });

      await repo.post(capture);
      await expect(repo.post(refund)).rejects.toBeInstanceOf(
        PostingConflictError,
      );
    });

    it("after a PostingConflictError, a subsequent unrelated post() still succeeds (pool isn't left broken)", async () => {
      const operationId = randomUUID();
      const first = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_10",
        merchantId: "acme",
        amount: Money.of(300, "USD"),
      });
      const conflicting = PostingGroup.forCapture({
        operationId,
        paymentId: "pay_10",
        merchantId: "acme",
        amount: Money.of(999, "USD"),
      });
      await repo.post(first);
      await expect(repo.post(conflicting)).rejects.toBeInstanceOf(
        PostingConflictError,
      );

      const unrelated = PostingGroup.forCapture({
        operationId: randomUUID(),
        paymentId: "pay_10b",
        merchantId: "acme",
        amount: Money.of(50, "USD"),
      });
      const result = await repo.post(unrelated);
      expect(result.outcome).toBe("posted");
    });
  });

  describe("atomicity", () => {
    it(
      "a group exceeding Postgres bigint range is rejected wholesale — nothing partially written " +
        "(a domain-valid-but-DB-rejected group is otherwise unreachable through this port: steps 1+2's " +
        "validation already rejects non-positive/mismatched-currency/unbalanced entries before a single row " +
        "is written, so a CHECK-violation-partway-through-a-group can't happen any other way)",
      async () => {
        const operationId = randomUUID();
        // Money.of doesn't cap the amount (a known domain-layer gap, out of
        // scope for this step) — this is the one legitimate way to build a
        // domain-valid group Postgres's bigint column can't store.
        const group = PostingGroup.forCapture({
          operationId,
          paymentId: "pay_overflow",
          merchantId: "acme",
          amount: Money.of(2 ** 63, "USD"),
        });

        await expect(repo.post(group)).rejects.toBeDefined();
        expect(await rowCount(operationId)).toBe(0);
        expect(await repo.findByOperationId(operationId)).toEqual([]);
      },
    );
  });

  describe("balances", () => {
    it("getBalance(merchant:acme, USD) after a 1500 USD capture equals 1500 and matches balanceOf(findByAccount)", async () => {
      const merchant = LedgerAccount.merchant("acme");
      await repo.post(
        PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId: "pay_bal_1",
          merchantId: "acme",
          amount: Money.of(1500, "USD"),
        }),
      );

      const balance = await repo.getBalance(merchant, "USD");
      expect(balance.equals(Money.of(1500, "USD"))).toBe(true);

      const entries = await repo.findByAccount(merchant, "USD");
      expect(balanceOf(entries, merchant, "USD").equals(balance)).toBe(true);
    });

    it("sign convention: getBalance(acquirer_clearing, USD) after the same 1500 USD capture equals -1500", async () => {
      const clearing = LedgerAccount.acquirerClearing();
      await repo.post(
        PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId: "pay_bal_2",
          merchantId: "acme",
          amount: Money.of(1500, "USD"),
        }),
      );

      const balance = await repo.getBalance(clearing, "USD");
      expect(balance.equals(Money.of(-1500, "USD"))).toBe(true);
    });

    it("capture 2000 then refund 500 (two operations): merchant 1500, clearing -1500, both match balanceOf", async () => {
      const merchant = LedgerAccount.merchant("acme");
      const clearing = LedgerAccount.acquirerClearing();
      const paymentId = "pay_bal_3";
      await repo.post(
        PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId,
          merchantId: "acme",
          amount: Money.of(2000, "USD"),
        }),
      );
      await repo.post(
        PostingGroup.forRefund({
          operationId: randomUUID(),
          paymentId,
          merchantId: "acme",
          amount: Money.of(500, "USD"),
        }),
      );

      const merchantBalance = await repo.getBalance(merchant, "USD");
      const clearingBalance = await repo.getBalance(clearing, "USD");
      expect(merchantBalance.equals(Money.of(1500, "USD"))).toBe(true);
      expect(clearingBalance.equals(Money.of(-1500, "USD"))).toBe(true);

      const merchantEntries = await repo.findByAccount(merchant, "USD");
      const clearingEntries = await repo.findByAccount(clearing, "USD");
      expect(
        balanceOf(merchantEntries, merchant, "USD").equals(merchantBalance),
      ).toBe(true);
      expect(
        balanceOf(clearingEntries, clearing, "USD").equals(clearingBalance),
      ).toBe(true);
    });

    it("USD and EUR postings to the same merchant stay isolated", async () => {
      const merchant = LedgerAccount.merchant("acme");
      await repo.post(
        PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId: "pay_bal_4",
          merchantId: "acme",
          amount: Money.of(1000, "USD"),
        }),
      );
      await repo.post(
        PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId: "pay_bal_4",
          merchantId: "acme",
          amount: Money.of(300, "EUR"),
        }),
      );

      const usdBalance = await repo.getBalance(merchant, "USD");
      expect(usdBalance.equals(Money.of(1000, "USD"))).toBe(true);

      const usdEntries = await repo.findByAccount(merchant, "USD");
      expect(balanceOf(usdEntries, merchant, "USD").equals(usdBalance)).toBe(
        true,
      );
      expect(usdEntries.every((e) => e.amount.currency === "USD")).toBe(true);
    });

    it("getBalance for an account with zero entries returns Money.zero(currency), not a throw", async () => {
      const balance = await repo.getBalance(
        LedgerAccount.merchant("nobody"),
        "USD",
      );
      expect(balance.equals(Money.zero("USD"))).toBe(true);
    });

    it("after a mixed capture+refund workload, assertZeroSum over entries read back via repository methods does not throw", async () => {
      const paymentId = "pay_bal_5";
      await repo.post(
        PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId,
          merchantId: "acme",
          amount: Money.of(1200, "USD"),
        }),
      );
      await repo.post(
        PostingGroup.forRefund({
          operationId: randomUUID(),
          paymentId,
          merchantId: "acme",
          amount: Money.of(300, "USD"),
        }),
      );
      await repo.post(
        PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId,
          merchantId: "beta",
          amount: Money.of(500, "USD"),
        }),
      );

      const entries = await repo.findByPaymentId(paymentId);
      expect(() => assertZeroSum(entries)).not.toThrow();
    });
  });

  describe("other reads", () => {
    it("findByPaymentId spans a capture and a refund for one paymentId, excludes an unrelated payment, ordered by createdAt", async () => {
      const paymentId = "pay_reads_1";
      const capture = PostingGroup.forCapture({
        operationId: randomUUID(),
        paymentId,
        merchantId: "acme",
        amount: Money.of(400, "USD"),
        now: new Date("2024-01-01T00:00:00Z"),
      });
      const refund = PostingGroup.forRefund({
        operationId: randomUUID(),
        paymentId,
        merchantId: "acme",
        amount: Money.of(100, "USD"),
        now: new Date("2024-02-01T00:00:00Z"),
      });
      const unrelated = PostingGroup.forCapture({
        operationId: randomUUID(),
        paymentId: "pay_reads_other",
        merchantId: "acme",
        amount: Money.of(999, "USD"),
      });

      await repo.post(capture);
      await repo.post(refund);
      await repo.post(unrelated);

      const found = await repo.findByPaymentId(paymentId);
      expect(found).toHaveLength(4);
      expect(new Set(found.map((e) => e.operationId))).toEqual(
        new Set([capture.operationId, refund.operationId]),
      );
      const createdAts = found.map((e) => e.createdAt.getTime());
      expect(createdAts).toEqual([...createdAts].sort((a, b) => a - b));
    });

    it("findByOperationId on a never-posted id returns []", async () => {
      const found = await repo.findByOperationId(randomUUID());
      expect(found).toEqual([]);
    });
  });
});
