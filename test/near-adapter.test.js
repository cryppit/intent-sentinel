import test from "node:test";
import assert from "node:assert/strict";
import { traceToLegs, readOrder } from "../src/adapters/near.js";
import { paidReport, matchedReport, refundedReport, privateReport, stuckReport, notFoundReport, swappedReport, twoPaidReport, secondUnprovenReport, partialRefundReport, unseenReport, flagged, unverifiedLedger } from "./stubs/reports.js";

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
test("the NEAR ledger is balanced when no swap ran", () => {
  const credit = legs(paidReport)[1];
  assert.equal(credit.amountIn, "100");
  assert.deepEqual(credit.amountOut, ["100"]);
});
test("a swap changes the token, so the balance says it wasn't checked", () => {
  assert.equal(legs(swappedReport)[1].amountIn, undefined);
  assert.match(legs(swappedReport)[1].unchecked, /swap/);
});
test("each hop becomes evidence with its chain time", () => {
  const e = traceToLegs(swappedReport, NOW).evidence.find((x) => x.ref === "NEARSWAP");
  assert.equal(e.class, "PROVEN");
  assert.equal(e.observedAt, "2026-09-21T14:14:10.000Z");
});
test("the payout's time comes from the chain, not the read", () =>
  assert.equal(traceToLegs(paidReport, NOW).evidence.find((x) => x.ref === "0xpayout").observedAt, "2026-09-21T14:15:05.000Z"));
test("the deposit never looks newer than its credit", () =>
  assert.equal(traceToLegs(paidReport, NOW).evidence.find((x) => x.ref === "0xorigin").observedAt, "2026-09-21T14:13:20.000Z"));
test("the read itself is evidence, so a verdict knows when it looked", () =>
  assert.ok(traceToLegs(paidReport, NOW).evidence.some((x) => x.kind === "read" && x.observedAt === NOW)));
test("identifiers don't depend on how the order was found", () => {
  const a = traceToLegs(paidReport, NOW).identifiers;
  assert.deepEqual(traceToLegs({ ...paidReport, resolvedVia: "origin" }, NOW).identifiers, a);
  assert.ok(a.includes("order.example") && a.includes("NEARCREDIT") && a.includes("0xpayout"));
});
test("an EVM payout is followed", () =>
  assert.deepEqual(traceToLegs(paidReport, NOW).next, [{ kind: "evm-tx", chain: "eth", value: "0xpayout", recipient: "0xdest" }]));
test("an inferred payout is not followed as if proven", () => assert.deepEqual(traceToLegs(matchedReport, NOW).next, []));
test("a dead source gives a failed leg, not a throw", async () => {
  const r = await readOrder("x", { now: NOW, check: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(r.legs[0].status, "LOOKUP_FAILED");
});
test("an unknown hash is a plain answer, not a failed source", async () => {
  const r = await readOrder("x", { now: NOW, check: async () => { throw new Error("no such transaction"); } });
  assert.match(r.notFound, /no such transaction/);
});

test("no order behind an id is a plain answer, never a proven absence", async () => {
  const r = await readOrder("x", { now: NOW, check: async () => notFoundReport });
  assert.match(r.notFound, /No NEAR Intents order/);
});
test("every withdrawal gets its own leg", () =>
  assert.deepEqual(legs(twoPaidReport).slice(2).map((l) => [l.status, l.ref]), [["PAID_OUT", "0xpayout"], ["PAID_OUT", "0xpayout2"]]));
test("a withdrawal with no payout found isn't hidden", () =>
  assert.equal(legs(secondUnprovenReport).find((l) => l.status === "PAYOUT_UNSEEN").class, "UNKNOWN"));
test("a partial refund next to a swap shows both ends", () =>
  assert.deepEqual(legs(partialRefundReport).slice(2).map((l) => l.status).sort(), ["PAID_OUT", "REFUNDED"]));
test("a searched-for payout that wasn't found doesn't say paid out", () =>
  assert.equal(legs(unseenReport).at(-1).status, "PAYOUT_UNSEEN"));
test("both EVM payouts are followed", () =>
  assert.equal(traceToLegs(twoPaidReport, NOW).next.length, 2));
test("a non-EVM 0x payout isn't sent to the EVM reader", () =>
  assert.deepEqual(traceToLegs({ ...paidReport, payout: { ...paidReport.payout, chain: "aptos" } }, NOW).next, []));
for (const kind of ["incomplete_history", "ledger_mismatch", "destination_missing", "several_orders", "payout_bounced", "withdrawal_refused", "withdrawal_returned", "locked", "executing"])
  test(`the tracer's ${kind} warning is kept`, () => assert.equal(traceToLegs(flagged(kind), NOW).warnings[0].kind, kind));
test("a harmless note isn't a warning", () => assert.deepEqual(traceToLegs(flagged("settled_late"), NOW).warnings, []));
test("a ledger that couldn't be checked is a failed read", () =>
  assert.ok(legs(unverifiedLedger).some((l) => l.status === "LOOKUP_FAILED")));
for (const [name, err] of [["a timeout", Object.assign(new Error("t"), { name: "TimeoutError" })], ["a bad body", new SyntaxError("bad json")], ["an HTTP error", new Error("FastNEAR answered HTTP 404")]])
  test(`${name} is a failed source, not bad input`, async () => {
    const r = await readOrder("x", { now: NOW, check: async () => { throw err; } });
    assert.equal(r.legs?.[0].status, "LOOKUP_FAILED");
  });
test("a source that hangs fails instead of waiting for ever", async () => {
  const r = await readOrder("x", { now: NOW, timeoutMs: 20, check: () => new Promise(() => {}) });
  assert.equal(r.legs[0].status, "LOOKUP_FAILED");
});

const busy = (account) => async () => { throw new Error(`${account} has 7730537 transactions: that is a wallet account, not one swap. Paste the swap's NEAR transaction or your deposit transaction instead.`); };
test("a pasted transaction signed by a busy solver account is explained, not called a wallet", async () => {
  const r = await readOrder("Agmwz426kYPRJ7j4m3gEyynjx9TSqYtWzYNNjBAwMFJW", { now: NOW, check: busy("solver-priv-liq.near") });
  assert.match(r.notFound, /solver-priv-liq\.near/);
  assert.match(r.notFound, /many orders/);
  assert.doesNotMatch(r.notFound, /wallet account/);
});
test("a pasted busy account keeps the wallet-account answer", async () => {
  const r = await readOrder("solver-priv-liq.near", { now: NOW, check: busy("solver-priv-liq.near") });
  assert.match(r.notFound, /wallet account/);
});
