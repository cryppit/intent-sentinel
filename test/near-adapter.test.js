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
  assert.match(r.notFound, /no NEAR Intents swap/);
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
test("a pasted transaction in a busy account says whose account it is, not who signed it", async () => {
  const r = await readOrder("Agmwz426kYPRJ7j4m3gEyynjx9TSqYtWzYNNjBAwMFJW", { now: NOW, check: busy("gnk-usd.near") });
  assert.match(r.notFound, /gnk-usd\.near/);
  assert.match(r.notFound, /many swaps/);
  assert.doesNotMatch(r.notFound, /signed|made by|wallet account/);
  assert.match(r.notFound, /paste/i);
});
test("a pasted busy account says it has many swaps and asks for the one transaction", async () => {
  const r = await readOrder("gnk-usd.near", { now: NOW, check: busy("gnk-usd.near") });
  assert.match(r.notFound, /gnk-usd\.near has many swaps/);
  assert.match(r.notFound, /transaction ID of the one swap/);
  assert.doesNotMatch(r.notFound, /wallet account/);
});
const roundTripReport = { ...paidReport, flags: [{ kind: "confidential", detail: "part of the order went through Confidential Intents and came back; the withdrawal after it is public" }] };
test("a swap that settled privately shows the private step between the credit and the payout", () => {
  const l = legs(roundTripReport);
  assert.deepEqual(l.map((x) => x.status), ["DEPOSIT_CONFIRMED", "CREDITED", "NOT_VISIBLE", "PAID_OUT"]);
  assert.equal(l.at(-1).class, "PROVEN");
});
test("a private step carries the time it was last seen, so its age can be judged", () => assert.ok(legs(privateReport).at(-1).at));

// An account the user owns can hold many orders. The tracer then skips the intents.near balance check on purpose; that
// is not a failed read, and it must not hold a proven payout open.
const SEVERAL = "this account received 30 separate deposits, each finished before the next arrived; this report follows the one with the transaction you gave (28 of 30). Paste another one's NEAR transaction to see it.";
const severalReport = { ...paidReport, flags: [{ kind: "several_orders", count: 30, shown: 28, detail: SEVERAL }], balanceCheck: { status: "not_verified", reason: "this account held several orders, and intents.near shows only what they left together" } };
test("a balance check skipped because the account holds several orders is not a failed read", () =>
  assert.ok(!legs(severalReport).some((l) => l.status === "LOOKUP_FAILED")));
test("the several-orders note names the swap shown, and asks nobody to act", () => {
  const [w] = traceToLegs(severalReport, NOW).warnings;
  assert.equal(w.party, "none");
  assert.match(w.detail, /30 separate swaps/);
  assert.match(w.detail, /the transaction you pasted \(28 of 30\)/);
  assert.doesNotMatch(w.detail, /latest|deposit address/);
});
test("with no transaction given, the several-orders note says it shows the latest", () => {
  const latest = { ...severalReport, flags: [{ kind: "several_orders", detail: SEVERAL.replace("the one with the transaction you gave", "the latest").replace("28 of 30", "30 of 30") }] };
  assert.match(traceToLegs(latest, NOW).warnings[0].detail, /shows the latest one \(30 of 30\)/);
});
test("a proven payout in a several-orders account is paid out, not held open", async () => {
  const { buildVerdict } = await import("../src/verdict.js");
  const v = await buildVerdict(traceToLegs(severalReport, NOW));
  assert.equal(v.journey, "PAID_OUT");
  assert.equal(v.nextAction.party, "none");
  assert.match(v.warnings[0].detail, /30 separate swaps/);
});

// The tracer reads a whole account's history. An account with thousands of transactions can't be read, so a pasted
// withdrawal is checked on its own: its payout is still a fact. Recorded: a TON USDT payout through HOT (8 Nov 2026),
// with the account made to look busy.
import { readFileSync } from "node:fs";
const tonRec = JSON.parse(readFileSync(new URL("./stubs/hot-ton-usdt.json", import.meta.url), "utf8"));
function busyChains({ nearTxs = [tonRec.near] } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : {};
    if (u.endsWith("/v0/transactions")) return Response.json({ transactions: nearTxs.filter((t) => body.tx_hashes.includes(t.transaction.hash)) });
    if (u.endsWith("/v0/account")) return Response.json({ account_txs: [{ transaction_hash: "x", tx_block_height: 1, tx_block_timestamp: "1" }], resume_token: "more", txs_count: 9000 });
    if (u.includes("bridge-indexer.chaindefuser.com")) return Response.json(tonRec.hotIndexer);
    if (u.includes("toncenter.com/api/v3/transactions")) return Response.json(tonRec.tonTx);
    if (u.includes("toncenter.com/api/v3/jetton/wallets")) return Response.json(tonRec.jettonWallets);
    return new Response("not stubbed", { status: 503 });
  };
}
const LATER = "2026-11-08T09:00:00Z";
test("a pasted withdrawal from an account too busy to read is checked on its own", async () => {
  const r = await readOrder(tonRec.nearTx, { now: LATER, fetch: busyChains() });
  assert.ok(!r.notFound, r.notFound);
  const end = r.legs.find((l) => l.id.startsWith("end:"));
  assert.equal(end.status, "PAID_OUT");
  assert.equal(end.class, "PROVEN");
  assert.equal(end.provider, "ton");
  assert.ok(!r.legs.some((l) => ["HELD", "LOOKUP_FAILED", "NOT_VISIBLE"].includes(l.status)), r.legs.map((l) => l.status).join());
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].party, "none");
  assert.match(r.warnings[0].detail, /many swaps/);
  assert.match(r.warnings[0].detail, /only the payout in the transaction you pasted/);
});
test("a pasted busy account, with no transaction, gets the plain many-swaps answer", async () => {
  const r = await readOrder("a1ae4f8fc3fbbd7121f799cd0f6b5653845b5864992696f080a9648752682f65", { now: LATER, fetch: busyChains() });
  assert.match(r.notFound, /has many swaps/);
});
