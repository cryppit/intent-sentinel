import test from "node:test";
import assert from "node:assert/strict";
import { openCase } from "../src/case.js";

const NOW = "2026-11-06T00:00:00Z";
const NEAR_TX = "9poz2Ntoi16oaJZjyWub2QR8yLWveaYSPpGayDLHapvR";
const NEAR_TX_2 = "3yZe7dPmQ2xVwKhJ9tN4sLbRf6GuCa8EoT1WiXnYqM5k";
const ADDRESS = "0x" + "a".repeat(40);
const HASH = "0x" + "b".repeat(64);
const SHARED = ["order.near", NEAR_TX, NEAR_TX_2];
const evidence = [{ id: "e", source: "t", kind: "read", ref: "r", observedAt: NOW, class: "PROVEN" }];
const paid = (next = []) => ({ legs: [{ id: "p", provider: "eth", ref: HASH, status: "PAID_OUT", class: "PROVEN", evidence: [] }], edges: [], evidence, claims: [], identifiers: SHARED, next });
const stub = (over) => ({ now: NOW, adapters: { order: async () => paid(), transfer: async () => ({ notFound: "no" }), evmTx: async () => paid(), status: async () => null, ...over } });

test("following a payout adds its facts to the same leg", async () => {
  const ctx = stub({
    order: async () => paid([{ kind: "evm-tx", chain: "eth", value: HASH }]),
    evmTx: async () => ({ legs: [{ id: "x", provider: "eth", ref: HASH, status: "PAID_OUT", class: "PROVEN", evidence: [], facts: { recipientIsContract: true } }], edges: [], evidence: [], claims: [], identifiers: [HASH], next: [] }),
  });
  const { caseData, verdict } = await openCase(NEAR_TX, ctx);
  assert.equal(caseData.legs.length, 1);
  assert.equal(caseData.legs[0].facts.recipientIsContract, true);
  assert.ok(verdict.findings.includes("RECIPIENT_IS_CONTRACT"));
});
test("following links reaches every leg once, even with a loop", async () => {
  let calls = 0;
  const loop = { kind: "evm-tx", chain: "eth", value: HASH };
  const ctx = stub({
    order: async () => paid([loop]),
    evmTx: async () => { calls += 1; return { ...paid([loop]), legs: [{ id: "f", provider: "eth", ref: "other", status: "CONTRACT_FORWARDED", class: "PROVEN", evidence: [] }] }; },
  });
  assert.equal((await openCase(NEAR_TX, ctx)).caseData.legs.length, 2);
  assert.equal(calls, 1);
});
test("a chain of links stops at eight hops", async () => {
  let n = 0;
  const ctx = stub({
    order: async () => paid([{ kind: "evm-tx", chain: "eth", value: "0x0" }]),
    evmTx: async () => { n += 1; return { ...paid([{ kind: "evm-tx", chain: "eth", value: `0x${n}` }]), legs: [] }; },
  });
  await openCase(NEAR_TX, ctx);
  assert.equal(n, 8);
});
test("any identifier of a case gives the same incident", async () => {
  const a = await openCase(NEAR_TX, stub());
  const b = await openCase(NEAR_TX_2, stub());
  assert.equal(a.verdict.incident, b.verdict.incident);
});
test("one dead source gives INSUFFICIENT_EVIDENCE and names it", async () => {
  const dead = { legs: [{ id: "f", provider: "eth", ref: HASH, status: "LOOKUP_FAILED", class: "UNKNOWN", evidence: [] }], edges: [], evidence: [], claims: [], identifiers: [], next: [] };
  const { verdict } = await openCase(NEAR_TX, stub({ order: async () => paid([{ kind: "evm-tx", chain: "eth", value: HASH }]), evmTx: async () => dead }));
  assert.equal(verdict.journey, "INSUFFICIENT_EVIDENCE");
  assert.ok(verdict.legs.some((l) => l.status === "LOOKUP_FAILED"));
});
test("a transaction the tracer doesn't know is tried on Omni", async () => {
  const omni = { legs: [{ id: "o", provider: "omni", status: "INITIALISED", class: "PROVEN", evidence: [], finish: { step: "sign_transfer", by: "omni-relayer" } }], edges: [], evidence, claims: [], identifiers: ["near:7"], next: [] };
  const { verdict } = await openCase(NEAR_TX, stub({ order: async () => ({ notFound: "no" }), transfer: async () => omni }));
  assert.equal(verdict.journey, "GATED_FINISH");
});
test("an Omni id goes straight to Omni", async () => {
  let asked = null;
  await openCase("Near:7", stub({ transfer: async (id) => { asked = id; return paid(); } }));
  assert.equal(asked, "near:7");
});
test("an address with no order is a plain error", async () =>
  assert.match((await openCase(ADDRESS, stub({ order: async () => ({ notFound: "nothing here" }) }))).error, /nothing here|No order/));
test("nonsense never reaches an adapter", async () => {
  let called = false;
  const r = await openCase("hello there", stub({ order: async () => { called = true; return paid(); } }));
  assert.ok(r.error);
  assert.equal(called, false);
});
test("a deposit address also collects the 1Click claim", async () => {
  const claim = { by: "1click", status: "FAILED", observedAt: NOW, class: "REPORTED" };
  assert.deepEqual((await openCase(ADDRESS, stub({ status: async () => ({ claim, nearTx: null }) }))).caseData.claims, [claim]);
});
test("a deposit address only 1Click knows is followed to its NEAR order", async () => {
  const claim = { by: "1click", status: "REFUNDED", observedAt: NOW, class: "REPORTED" };
  const asked = [];
  const r = await openCase(ADDRESS, stub({ order: async (id) => { asked.push(id); return id === NEAR_TX ? paid() : { notFound: "no" }; }, status: async () => ({ claim, nearTx: NEAR_TX }) }));
  assert.deepEqual(asked, [ADDRESS, NEAR_TX]);
  assert.equal(r.verdict.journey, "PAID_OUT");
  assert.deepEqual(r.caseData.claims, [claim]);
});
test("a reverted refund can't stay finished, and leaves the proof", async () => {
  const refund = { ...paid([{ kind: "evm-tx", chain: "eth", value: HASH }]), legs: [{ id: "r", provider: "eth", ref: HASH, status: "REFUNDED", class: "PROVEN", evidence: [] }], evidence: [...evidence, { id: "pay", source: "eth", kind: "tx", ref: HASH, observedAt: NOW, class: "PROVEN" }] };
  const reverted = { legs: [{ id: "x", provider: "eth", ref: HASH, status: "PAID_OUT", class: "UNKNOWN", evidence: [], facts: { reverted: true } }], edges: [], evidence: [], claims: [], identifiers: [HASH], next: [] };
  const { caseData, verdict } = await openCase(NEAR_TX, stub({ order: async () => refund, evmTx: async () => reverted }));
  assert.equal(verdict.journey, "INSUFFICIENT_EVIDENCE");
  assert.equal(caseData.legs.length, 1);
  assert.equal(caseData.legs[0].status, "NOT_PROVEN");
  assert.equal(caseData.evidence.find((e) => e.ref === HASH).class, "UNKNOWN");
});
test("following an EVM refund doesn't add a second leg", async () => {
  const refund = { ...paid([{ kind: "evm-tx", chain: "eth", value: HASH }]), legs: [{ id: "r", provider: "eth", ref: HASH, status: "REFUNDED", class: "PROVEN", evidence: [] }] };
  const { caseData } = await openCase(NEAR_TX, stub({ order: async () => refund }));
  assert.deepEqual(caseData.legs.map((l) => l.status), ["REFUNDED"]);
});
test("a tracer warning reaches the verdict through the case", async () => {
  const warned = { ...paid(), warnings: [{ kind: "locked", party: "near-intents", detail: "locked" }] };
  assert.equal((await openCase(NEAR_TX, stub({ order: async () => warned }))).verdict.journey, "TRACE_WARNING");
});
test("a failed read keeps what was asked in its incident", async () => {
  const dead = { legs: [{ id: "f", provider: "near", status: "LOOKUP_FAILED", class: "UNKNOWN", evidence: [] }], edges: [], evidence: [], claims: [], identifiers: [], next: [] };
  const a = await openCase(NEAR_TX, stub({ order: async () => dead }));
  const b = await openCase("0x" + "c".repeat(64), stub({ order: async () => dead }));
  assert.notEqual(a.verdict.incident, b.verdict.incident);
});
test("a hash doesn't ask 1Click", async () => {
  let asked = false;
  await openCase(NEAR_TX, stub({ claim: async () => { asked = true; return null; } }));
  assert.equal(asked, false);
});
test("legs are linked in order", async () => {
  const two = { ...paid(), legs: [{ id: "c", provider: "near-intents", status: "CREDITED", class: "PROVEN", evidence: [] }, { id: "p", provider: "eth", status: "PAID_OUT", class: "PROVEN", evidence: [] }] };
  assert.deepEqual((await openCase(NEAR_TX, stub({ order: async () => two }))).caseData.edges, [{ from: "c", to: "p", kind: "paid-to" }]);
});

test("two legs from one source stay two legs, even with one reference", async () => {
  const both = { ...paid(), legs: [{ id: "a", provider: "sol", ref: "S", status: "DEPOSIT_CONFIRMED", class: "PROVEN", evidence: [] }, { id: "b", provider: "omni", ref: "S", status: "INITIALISED", class: "INFERRED", evidence: [] }] };
  assert.equal((await openCase(NEAR_TX, stub({ order: async () => both }))).caseData.legs.length, 2);
});

// The hash a user is most likely to hold is the payout's: the money arriving. It is not a deposit.
const PAYOUT_TX = "0x" + "f".repeat(64);
test("a pasted payout transaction leads to its order when the bridge's record names it", async () => {
  const asked = [];
  const ctx = stub({
    order: async (id) => { asked.push(id); return id === NEAR_TX ? paid() : { notFound: "no deposit names this" }; },
    payoutSide: async () => ({ nearTx: NEAR_TX, chain: "bsc", by: "the HOT bridge" }),
  });
  const r = await openCase(PAYOUT_TX, ctx);
  assert.ok(r.verdict, r.error);
  assert.deepEqual(asked, [PAYOUT_TX, NEAR_TX]);
  assert.equal(r.verdict.journey, "PAID_OUT");
});
test("a pasted payout transaction with no record back gets plain words, not an error", async () => {
  const notice = "That's the payout transaction (money arriving). NEAR Intents sent it on Arbitrum. To check your swap, paste the transaction that sent the money, or the deposit address.";
  const r = await openCase(PAYOUT_TX, stub({ order: async () => ({ notFound: "no deposit names this" }), payoutSide: async () => ({ notice }) }));
  assert.equal(r.error, notice);
  assert.equal(r.notice, true);
});
test("an unknown transaction that isn't a payout keeps its first answer", async () => {
  const r = await openCase(PAYOUT_TX, stub({ order: async () => ({ notFound: "no deposit names this" }), payoutSide: async () => null }));
  assert.equal(r.error, "no deposit names this");
  assert.ok(!r.notice);
});
test("a many-swaps answer is a notice, not bad input", async () => {
  const r = await openCase("gnk-usd.near", stub({ order: async () => ({ notFound: "gnk-usd.near has many swaps", notice: true }) }));
  assert.equal(r.notice, true);
});
