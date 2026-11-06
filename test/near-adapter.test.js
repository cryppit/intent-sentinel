import test from "node:test";
import assert from "node:assert/strict";
import { traceToLegs, readOrder } from "../src/adapters/near.js";
import { paidReport, matchedReport, refundedReport, privateReport, stuckReport, notFoundReport, swappedReport } from "./stubs/reports.js";

const NOW = "2026-11-06T00:00:00Z";
const legs = (r) => traceToLegs(r, NOW).legs;

test("a paid order becomes deposit, credit and payout legs", () => {
  assert.deepEqual(legs(paidReport).map((l) => l.status), ["DEPOSIT_CONFIRMED", "CREDITED", "PAID_OUT"]);
  assert.ok(legs(paidReport).every((l) => l.class === "PROVEN"));
});
test("a refunded order ends REFUNDED", () => assert.equal(legs(refundedReport).at(-1).status, "REFUNDED"));
test("a confidential hop stays NOT_VISIBLE", () => assert.equal(legs(privateReport).at(-1).class, "NOT_VISIBLE"));
test("a payout matched by amount and time is inferred, not proven", () => assert.equal(legs(matchedReport).at(-1).class, "INFERRED"));
test("a stuck order is held past its window", () => {
  const last = legs(stuckReport).at(-1);
  assert.equal(last.status, "HELD");
  assert.ok(Date.parse(last.window.dueBy) < Date.parse(NOW));
});
test("no deposit found is DEPOSIT_NOT_FOUND", () => assert.equal(legs(notFoundReport)[0].status, "DEPOSIT_NOT_FOUND"));
test("the NEAR ledger is balanced when no swap ran", () => {
  const credit = legs(paidReport)[1];
  assert.equal(credit.amountIn, "100");
  assert.deepEqual(credit.amountOut, ["100"]);
});
test("a swap changes the token, so no balance is claimed", () => assert.equal(legs(swappedReport)[1].amountIn, undefined));
test("each hop becomes evidence with its chain time", () => {
  const e = traceToLegs(swappedReport, NOW).evidence.find((x) => x.ref === "NEARSWAP");
  assert.equal(e.class, "PROVEN");
  assert.equal(e.observedAt, "2026-09-21T14:14:10.000Z");
});
test("the read itself is evidence, so a verdict knows when it looked", () =>
  assert.ok(traceToLegs(paidReport, NOW).evidence.some((x) => x.kind === "read" && x.observedAt === NOW)));
test("identifiers don't depend on how the order was found", () => {
  const a = traceToLegs(paidReport, NOW).identifiers;
  assert.deepEqual(traceToLegs({ ...paidReport, resolvedVia: "origin" }, NOW).identifiers, a);
  assert.ok(a.includes("order.example") && a.includes("NEARCREDIT") && a.includes("0xpayout"));
});
test("an EVM payout is followed", () =>
  assert.deepEqual(traceToLegs(paidReport, NOW).next, [{ kind: "evm-tx", chain: "eth", value: "0xpayout" }]));
test("an inferred payout is not followed as if proven", () => assert.deepEqual(traceToLegs(matchedReport, NOW).next, []));
test("a dead source gives a failed leg, not a throw", async () => {
  const r = await readOrder("x", { now: NOW, check: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(r.legs[0].status, "LOOKUP_FAILED");
});
test("an unknown hash is a plain answer, not a failed source", async () => {
  const r = await readOrder("x", { now: NOW, check: async () => { throw new Error("no such transaction"); } });
  assert.match(r.notFound, /no such transaction/);
});
