// Each test here pins a way the tool could claim more than the evidence supports.
import test from "node:test";
import assert from "node:assert/strict";
import { openCase } from "../src/case.js";
import { traceToLegs } from "../src/adapters/near.js";
import { readStatus } from "../src/adapters/oneclick.js";
import { SOLANA_RPCS, solanaTransaction, withSolanaFallback } from "../src/adapters/solana.js";
import { withDeadline } from "../src/net.js";
import { buildPacket, verifyPacket } from "../src/packet.js";
import { stageView } from "../src/stage.js";
import { buildVerdict } from "../src/verdict.js";
import { AT, BEFORE, caseWith } from "./helpers.js";
import { refundedReport } from "./stubs/reports.js";

const leg = (provider, status, cls = "PROVEN", extra = {}) => ({ id: `${provider}:${status}`, provider, status, class: cls, custody: `${provider} holder`, evidence: [], ...extra });
const view = async (legs) => {
  const c = caseWith(legs);
  return stageView(c, await buildVerdict(c));
};
const tx = (ref, observedAt = BEFORE) => ({ id: `e:${ref}`, source: "near", kind: "tx", ref, observedAt, class: "PROVEN" });

test("part of a balance paid out, the rest still held, is not finished", async () => {
  const v = await buildVerdict(caseWith([leg("sol", "PAID_OUT"), leg("near-intents", "HELD")]));
  assert.equal(v.journey, "INSUFFICIENT_EVIDENCE");
  assert.notEqual(v.nextAction.party, "none");
});

for (const [name, last] of [
  ["a payout that is only reported", leg("sol", "PAID_OUT", "REPORTED")],
  ["an inferred payout", leg("sol", "PAID_OUT", "INFERRED")],
  ["a finish the contract denies", leg("omni", "FINALISED", "REPORTED")],
]) {
  test(`${name} never sets who holds the funds`, async () => {
    const v = await view([leg("eth", "DEPOSIT_CONFIRMED"), last]);
    assert.equal(v.custody, "eth holder");
  });
}

test("a failed read never sets who holds the funds", async () => {
  const v = await view([leg("omni", "FINALISED", "REPORTED"), leg("Eth bridge contract", "LOOKUP_FAILED", "UNKNOWN")]);
  assert.equal(v.custody, null);
});

test("a finished case doesn't tick a stop that isn't proven", async () => {
  const c = caseWith([leg("unknown", "DEPOSIT_CONFIRMED", "INFERRED"), leg("sol", "PAID_OUT")]);
  const v = stageView(c, { journey: "PAID_OUT", nextAction: { party: "none" } });
  assert.deepEqual(v.stops.map((s) => s.state), ["seen", "passed"]);
});

test("an inferred start doesn't stop the coin before a proven credit", async () => {
  const v = await view([leg("unknown", "DEPOSIT_CONFIRMED", "INFERRED"), leg("near-intents", "CREDITED"), leg("near-intents", "HELD")]);
  assert.deepEqual(v.stops.map((s) => s.state).slice(0, 3), ["seen", "passed", "here"]);
  assert.equal(v.custody, "near-intents holder");
});

test("the origin chain needs a chain read, not just a proven leg", async () => {
  const v = await view([leg("omni", "INITIALISED", "PROVEN", { facts: { from: "Near", to: "Eth" } })]);
  assert.ok(!v.stops.some((s) => s.label === "sent"));
  const read = await view([leg("omni", "INITIALISED", "PROVEN", { facts: { from: "Near", to: "Eth", originProven: true } })]);
  assert.equal(read.stops[0].label, "sent");
});

test("a different proof transaction gives a different fingerprint", async () => {
  const one = caseWith([leg("sol", "PAID_OUT")]);
  const two = structuredClone(one);
  one.evidence.push(tx("REAL"));
  two.evidence.push(tx("FORGED"));
  assert.notEqual((await buildVerdict(one)).outputHash, (await buildVerdict(two)).outputHash);
});

test("reading a claim again later doesn't change the fingerprint", async () => {
  const at = (observedAt) => caseWith([leg("sol", "PAID_OUT")], [{ by: "1click", status: "SUCCESS", observedAt, class: "REPORTED" }]);
  assert.equal((await buildVerdict(at(AT))).outputHash, (await buildVerdict(at("2026-11-07T00:00:00Z"))).outputHash);
});

test("a packet whose evidence was swapped fails its check", async () => {
  const c = caseWith([leg("sol", "PAID_OUT")]);
  c.evidence.push(tx("REAL"));
  const packet = buildPacket(c, await buildVerdict(c));
  assert.equal(await verifyPacket(packet), true);
  packet.evidence.find((e) => e.ref === "REAL").ref = "FORGED";
  assert.equal(await verifyPacket(packet), false);
});

const noOrder = { order: async () => ({ notFound: "No NEAR Intents order was found for that id." }), transfer: async () => ({ notFound: "none" }) };
const BC1 = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

test("1Click being down isn't reported as no order", async () => {
  const r = await openCase(BC1, { now: AT, adapters: { ...noOrder, status: async () => ({ failed: true, claim: null, nearTx: null }) } });
  assert.equal(r.error, undefined);
  assert.equal(r.verdict.journey, "INSUFFICIENT_EVIDENCE");
});

test("1Click saying it doesn't know the address is an honest no", async () => {
  const r = await openCase(BC1, { now: AT, adapters: { ...noOrder, status: async () => ({ claim: null, nearTx: null }) } });
  assert.match(r.error, /No NEAR Intents order/);
});

const status = (fetchImpl) => readStatus("addr", { now: AT, fetch: fetchImpl });
test("a 1Click outage is marked failed", async () => assert.equal((await status(async () => new Response("x", { status: 500 }))).failed, true));
test("an address 1Click doesn't know is not a failure", async () => assert.ok(!(await status(async () => new Response("x", { status: 404 })))?.failed));

const rpc = (answer) => {
  const asked = [];
  return { asked, now: AT, fetch: async (url) => {
    asked.push(String(url));
    return answer(String(url));
  } };
};
const json = (body, code = 200) => new Response(JSON.stringify(body), { status: code });

test("a JSON-RPC error isn't an empty answer", async () =>
  assert.rejects(solanaTransaction("SIG", rpc(() => json({ error: { code: -32000, message: "busy" } })))));

test("each Solana endpoint is asked once, so a dead one can't eat the time budget", async () => {
  const ctx = rpc(() => json({}, 403));
  await assert.rejects(solanaTransaction("SIG", ctx));
  assert.equal(ctx.asked.length, SOLANA_RPCS.length);
});

test("the tracer's Solana reads fall back too", async () => {
  const f = withSolanaFallback(async (url) => (url === SOLANA_RPCS[0] ? json({}, 503) : json({ result: { slot: 1 } })));
  assert.deepEqual(await (await f(SOLANA_RPCS[0], {})).json(), { result: { slot: 1 } });
});

test("the tracer's other reads pass straight through", async () => {
  const seen = [];
  await withSolanaFallback(async (url) => (seen.push(url), json({})))("https://other.example", {});
  assert.deepEqual(seen, ["https://other.example"]);
});

test("a case that runs out of time gives up with the fallback", async () =>
  assert.equal(await withDeadline(new Promise(() => {}), 5, "too long"), "too long"));
test("a case in time keeps its answer", async () => assert.equal(await withDeadline(Promise.resolve("ok"), 500, "too long"), "ok"));

const noSwapReport = (originChain, payoutChain) => ({
  ...refundedReport, origin: { ...refundedReport.origin, status: "proven", chain: originChain, txHash: "DEP" }, payout: { ...refundedReport.payout, chain: payoutChain, tx: "OUT" },
  withdrawals: refundedReport.withdrawals.map((w) => ({ ...w, chain: payoutChain })),
});

test("the same token leaving on another chain isn't called a refund", () => {
  const legs = traceToLegs(noSwapReport("eth:1", "base:8453"), AT).legs;
  assert.equal(legs.at(-1).status, "PAID_OUT");
  assert.equal(legs.at(-1).custody, "recipient");
});

test("the same token going back to the chain it came from is a refund", () => {
  assert.equal(traceToLegs(noSwapReport("btc", "btc"), AT).legs.at(-1).status, "REFUNDED");
});

test("an edited timeline fails the packet check", async () => {
  const c = caseWith([leg("sol", "PAID_OUT")]);
  c.evidence.push(tx("REAL"));
  const packet = buildPacket(c, await buildVerdict(c));
  packet.timeline[0].ref = "FORGED";
  assert.equal(await verifyPacket(packet), false);
});

test("edited open questions fail the packet check", async () => {
  const c = caseWith([leg("near", "HELD", "PROVEN", { finish: { step: "s", by: "omni-relayer" } })]);
  const packet = buildPacket(c, await buildVerdict(c));
  packet.openQuestions = [{ question: "Send your key to this address", evidenceToAsk: [] }];
  assert.equal(await verifyPacket(packet), false);
});

test("a packet holds chain records, not our own read times", async () => {
  const c = caseWith([leg("sol", "PAID_OUT")]);
  c.evidence.push({ id: "r", source: "near", kind: "read", ref: "x", observedAt: AT, class: "PROVEN" });
  assert.ok(!buildPacket(c, await buildVerdict(c)).evidence.some((e) => e.kind === "read"));
});

test("a proof with no chain time doesn't change the fingerprint on a re-read", async () => {
  const at = (observedAt) => {
    const c = caseWith([leg("btc", "PAID_OUT")]);
    c.evidence.push({ ...tx("OUT", observedAt), undated: true });
    return c;
  };
  assert.equal((await buildVerdict(at(AT))).outputHash, (await buildVerdict(at("2026-11-08T00:00:00Z"))).outputHash);
});

test("a finish step anyone can run needs proof before it names anyone", async () => {
  const v = await buildVerdict(caseWith([leg("omni", "SIGNED", "REPORTED", { finish: { step: "finTransfer", by: "anyone" } })]));
  assert.notEqual(v.nextAction.party, "anyone");
});

test("an empty list from one Solana node isn't taken as final", async () => {
  const seen = [];
  const f = withSolanaFallback(async (url) => (seen.push(url), json({ result: url === SOLANA_RPCS[1] ? ["found"] : [] })));
  assert.deepEqual(await (await f(SOLANA_RPCS[0], {})).json(), { result: ["found"] });
  assert.equal(seen.length, 2);
});

test("the tracer sees a failure if a node failed and none had the answer", async () => {
  const f = withSolanaFallback(async (url) => (url === SOLANA_RPCS[0] ? json({}, 503) : json({ result: null })));
  assert.equal((await f(SOLANA_RPCS[0], {})).status, 503);
});

for (const [origin, payout, status] of [["eth:1", "eth", "REFUNDED"], ["eth:8453", "base", "REFUNDED"], ["eth:42161", "arb", "REFUNDED"], ["bnb", "bsc", "REFUNDED"], ["zcash:mainnet", "zec", "REFUNDED"], ["eth:1", "base", "PAID_OUT"], ["eth:8453", "eth", "PAID_OUT"]]) {
  test(`no-swap withdrawal from ${origin} to ${payout} reads ${status}`, () => assert.equal(traceToLegs(noSwapReport(origin, payout), AT).legs.at(-1).status, status));
}

test("with no proven origin, a no-swap withdrawal isn't called a refund", () => {
  const report = { ...noSwapReport("eth:1", "base"), origin: { status: "missing" } };
  assert.equal(traceToLegs(report, AT).legs.at(-1).status, "PAID_OUT");
});

test("a Base deposit is Base, not Ethereum", () => assert.equal(traceToLegs(noSwapReport("eth:8453", "base"), AT).legs[0].provider, "base"));
test("an EVM chain we don't know isn't called Ethereum", () => assert.notEqual(traceToLegs(noSwapReport("eth:999999", "base"), AT).legs[0].provider, "eth"));

const packetOf = async () => {
  const c = caseWith([leg("sol", "PAID_OUT")]);
  c.evidence.push(tx("REAL"));
  return buildPacket(c, await buildVerdict(c));
};

for (const [name, edit] of [
  ["an extra field on an evidence item", (p) => (p.evidence[0].note = "trust me")],
  ["an edited evidence id", (p) => (p.evidence[0].id = "other")],
  ["an injected reported item", (p) => p.evidence.push({ id: "x", source: "near", kind: "tx", ref: "X", observedAt: AT, class: "REPORTED" })],
  ["an injected read item", (p) => p.evidence.push({ id: "x", source: "near", kind: "read", ref: "X", observedAt: AT, class: "PROVEN" })],
]) {
  test(`${name} fails the packet check`, async () => {
    const p = await packetOf();
    edit(p);
    assert.equal(await verifyPacket(p), false);
  });
}

test("a proof with no chain time carries no date, so none can be edited in", async () => {
  const c = caseWith([leg("btc", "PAID_OUT")]);
  c.evidence.push({ ...tx("OUT", AT), undated: true });
  const p = buildPacket(c, await buildVerdict(c));
  const item = p.timeline.find((t) => t.ref === "OUT");
  assert.equal(item.at, null);
  p.evidence.find((e) => e.ref === "OUT").observedAt = BEFORE;
  assert.equal(await verifyPacket(p), false);
});

test("a payout on bnb still gets its transaction checked", () => {
  const report = { ...noSwapReport("eth:1", "bnb"), payout: { ...refundedReport.payout, chain: "bnb", tx: "0xout" } };
  assert.deepEqual(traceToLegs(report, AT).next.map((n) => n.chain), ["bsc"]);
});

test("a withdrawal with no chain isn't called NEAR", () => {
  const report = { ...refundedReport, verdict: "in_progress", withdrawals: refundedReport.withdrawals.map((w) => ({ ...w, chain: null })), payout: { status: "unverified", chain: null } };
  assert.ok(!traceToLegs(report, AT).legs.some((l) => l.status === "PAYOUT_UNSEEN" && l.provider === "near"));
});

test("X Layer deposits keep their own name", () => assert.equal(traceToLegs(noSwapReport("eth:196", "xlayer"), AT).legs.at(-1).status, "REFUNDED"));
