import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LedgerAccount } from "./account.js";
import { Money } from "./money.js";
import { PostingGroup } from "./entry.js";
import { fingerprintOf } from "./posting-fingerprint.js";

const opId = () => randomUUID();

describe("fingerprintOf", () => {
  it("is the same for identical entries regardless of array order", () => {
    const group = PostingGroup.forCapture({
      operationId: opId(),
      paymentId: "pay_1",
      merchantId: "acme",
      amount: Money.of(500, "USD"),
    });
    const forward = fingerprintOf(group.entries);
    const reversed = fingerprintOf([...group.entries].reverse());
    expect(forward).toBe(reversed);
  });

  it("is the same across two separately-constructed forCapture calls with the same logical inputs (the retry case)", () => {
    const operationId = opId();
    const groupA = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_retry",
      merchantId: "acme",
      amount: Money.of(500, "USD"),
      now: new Date("2024-01-01T00:00:00Z"),
    });
    const groupB = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_retry",
      merchantId: "acme",
      amount: Money.of(500, "USD"),
      now: new Date("2024-06-01T00:00:00Z"),
    });

    // Entry ids are freshly minted per call — prove that alone.
    const idsA = groupA.entries.map((e) => e.id).sort();
    const idsB = groupB.entries.map((e) => e.id).sort();
    expect(idsA).not.toEqual(idsB);

    expect(fingerprintOf(groupA.entries)).toBe(fingerprintOf(groupB.entries));
  });

  it("changes when the amount changes", () => {
    const operationId = opId();
    const base = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_1",
      merchantId: "acme",
      amount: Money.of(500, "USD"),
    });
    const changed = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_1",
      merchantId: "acme",
      amount: Money.of(600, "USD"),
    });
    expect(fingerprintOf(base.entries)).not.toBe(
      fingerprintOf(changed.entries),
    );
  });

  it("changes when the account changes", () => {
    const operationId = opId();
    const base = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_1",
      merchantId: "acme",
      amount: Money.of(500, "USD"),
    });
    const changed = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_1",
      merchantId: "other",
      amount: Money.of(500, "USD"),
    });
    expect(fingerprintOf(base.entries)).not.toBe(
      fingerprintOf(changed.entries),
    );
  });

  it("changes when the currency changes", () => {
    const operationId = opId();
    const base = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_1",
      merchantId: "acme",
      amount: Money.of(500, "USD"),
    });
    const changed = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_1",
      merchantId: "acme",
      amount: Money.of(500, "EUR"),
    });
    expect(fingerprintOf(base.entries)).not.toBe(
      fingerprintOf(changed.entries),
    );
  });

  it("changes when the paymentId changes", () => {
    const operationId = opId();
    const base = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_1",
      merchantId: "acme",
      amount: Money.of(500, "USD"),
    });
    const changed = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_2",
      merchantId: "acme",
      amount: Money.of(500, "USD"),
    });
    expect(fingerprintOf(base.entries)).not.toBe(
      fingerprintOf(changed.entries),
    );
  });

  it("changes when the entryType changes (capture vs refund)", () => {
    const operationId = opId();
    const capture = PostingGroup.forCapture({
      operationId,
      paymentId: "pay_1",
      merchantId: "acme",
      amount: Money.of(500, "USD"),
    });
    const refund = PostingGroup.forRefund({
      operationId,
      paymentId: "pay_1",
      merchantId: "acme",
      amount: Money.of(500, "USD"),
    });
    expect(fingerprintOf(capture.entries)).not.toBe(
      fingerprintOf(refund.entries),
    );
  });

  it("changes when reversesOperationId changes", () => {
    const reversedOp1 = opId();
    const reversedOp2 = opId();
    const groupA = PostingGroup.create({
      operationId: opId(),
      paymentId: "pay_1",
      entryType: "reversal",
      reversesOperationId: reversedOp1,
      entries: [
        {
          account: LedgerAccount.acquirerClearing(),
          direction: "credit",
          amount: Money.of(500, "USD"),
        },
        {
          account: LedgerAccount.merchant("acme"),
          direction: "debit",
          amount: Money.of(500, "USD"),
        },
      ],
    });
    const groupB = PostingGroup.create({
      operationId: groupA.operationId,
      paymentId: "pay_1",
      entryType: "reversal",
      reversesOperationId: reversedOp2,
      entries: [
        {
          account: LedgerAccount.acquirerClearing(),
          direction: "credit",
          amount: Money.of(500, "USD"),
        },
        {
          account: LedgerAccount.merchant("acme"),
          direction: "debit",
          amount: Money.of(500, "USD"),
        },
      ],
    });
    expect(fingerprintOf(groupA.entries)).not.toBe(
      fingerprintOf(groupB.entries),
    );
  });

  it("does not collide when a paymentId containing '|', '\"', and a newline differs structurally from another", () => {
    const operationId = opId();
    const tricky = PostingGroup.forCapture({
      operationId,
      paymentId: 'pay|weird"id\nwith-separators',
      merchantId: "acme",
      amount: Money.of(500, "USD"),
    });
    // A differently-structured paymentId that, if naively `|`-joined, could
    // produce the same concatenated string as the tricky one above.
    const different = PostingGroup.forCapture({
      operationId,
      paymentId: 'pay|weird"id',
      merchantId: "acme",
      amount: Money.of(500, "USD"),
    });
    expect(fingerprintOf(tricky.entries)).not.toBe(
      fingerprintOf(different.entries),
    );
  });
});
