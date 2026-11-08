import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildVerdict } from "../src/verdict.js";
import { placeName, stageView } from "../src/stage.js";

const open = async (name) => {
  const caseData = JSON.parse(readFileSync(`fixtures/${name}/case.json`, "utf8"));
  return stageView(caseData, await buildVerdict(caseData));
};
const leg = (provider, status, cls = "PROVEN", extra = {}) => ({ id: `${provider}:${status}`, provider, status, class: cls, custody: "x", ...extra });
const verdict = (party, journey = "GATED_FINISH") => ({ journey, nextAction: { party, question: null } });

test("an open Omni transfer stops at the bridge and shows the chain it never reached", async () => {
  const v = await open("omni-665");
  assert.deepEqual(v.stops.map((s) => [s.name, s.state]), [["NEAR", "passed"], ["Omni bridge", "here"], ["Ethereum", "ahead"]]);
  assert.equal(v.stops[0].label, "sent");
  assert.equal(v.stops[2].label, "not reached yet");
  assert.equal(v.stops[2].class, null);
  assert.equal(v.tone, "act");
});

test("a proven deposit passes, an inferred step is where the coin stops", async () => {
  const v = await open("omni-666");
  assert.deepEqual(v.stops.map((s) => [s.name, s.state, s.class]), [["Solana", "passed", "PROVEN"], ["Omni bridge", "here", "INFERRED"], ["Destination", "ahead", null]]);
});

test("a settled case has no stop ahead and nobody lit but nobody", async () => {
  const v = await open("refund-5btc");
  assert.deepEqual(v.stops.map((s) => [s.name, s.state]), [["Bitcoin", "passed"], ["NEAR Intents", "passed"], ["Bitcoin", "passed"]]);
  assert.equal(v.tone, "done");
  assert.deepEqual(v.parties.filter((p) => p.lit).map((p) => p.key), ["none"]);
});

test("only the party the rules named is lit", async () => {
  const v = await open("omni-665");
  assert.deepEqual(v.parties.filter((p) => p.lit).map((p) => p.key), ["omni-relayer"]);
  assert.equal(v.partyName, "An Omni relayer");
});

test("a party outside the usual list still gets a lit place on the board", () => {
  const v = stageView({ legs: [leg("near", "HELD")] }, verdict("thorchain"));
  assert.deepEqual(v.parties.filter((p) => p.lit).map((p) => p.key), ["thorchain"]);
});

test("a failed read is never drawn as passed, and nothing after it is either", () => {
  const v = stageView({ legs: [leg("eth", "DEPOSIT_CONFIRMED"), leg("near-intents", "LOOKUP_FAILED", "UNKNOWN"), leg("sol", "PAID_OUT")] }, verdict("unknown", "INSUFFICIENT_EVIDENCE"));
  assert.deepEqual(v.stops.map((s) => s.state), ["passed", "here", "ahead"]);
  assert.equal(v.tone, "unknown");
  assert.equal(v.stops[1].failed, true);
});

test("a step that is only claimed never counts as reached", () => {
  const v = stageView({ legs: [leg("eth", "DEPOSIT_CONFIRMED"), leg("sol", "PAID_OUT", "REPORTED")] }, verdict("unknown", "INSUFFICIENT_EVIDENCE"));
  assert.deepEqual(v.stops.map((s) => s.state), ["passed", "here"]);
});

test("every step reached but no answer still shows where the proof ran out", () => {
  const v = stageView({ legs: [leg("eth", "DEPOSIT_CONFIRMED")] }, verdict("unknown", "INSUFFICIENT_EVIDENCE"));
  assert.deepEqual(v.stops.map((s) => [s.name, s.state]), [["Ethereum", "passed"], ["Destination", "here"]]);
});

test("an unknown provider gets its own name and no borrowed logo", () => {
  const v = stageView({ legs: [leg("somechain", "HELD")] }, verdict("anyone"));
  assert.equal(v.stops[0].name, "somechain");
  assert.equal(v.stops[0].logo, null);
});

test("the coin's last known holder comes from the stop it stopped at", async () => {
  assert.equal((await open("omni-665")).custody, "omni bridge");
  assert.equal((await open("refund-5btc")).custody, "refund address");
});

test("a confidential step gets no tick and doesn't stop a proven payout after it", async () => {
  const c = { legs: [leg("eth", "DEPOSIT_CONFIRMED"), leg("near-intents", "NOT_VISIBLE", "NOT_VISIBLE"), leg("sol", "PAID_OUT")], evidence: [], claims: [], identifiers: ["x"] };
  const v = stageView(c, await buildVerdict(c));
  assert.deepEqual(v.stops.map((s) => s.state), ["passed", "seen", "passed"]);
  assert.equal(v.stops[1].class, "NOT_VISIBLE");
});

test("the chain a transfer is heading to is named, whatever case the source used", () => {
  const v = stageView({ legs: [leg("omni", "SIGNED", "PROVEN", { facts: { to: "Bnb" } })] }, verdict("omni-relayer"));
  assert.deepEqual([v.stops.at(-1).name, v.stops.at(-1).logo], ["BNB Chain", "binance-smart-chain"]);
});

test("every logo the route can ask for exists", async () => {
  const { readdirSync } = await import("node:fs");
  const have = new Set(readdirSync("logos").map((f) => f.replace(".svg", "")));
  for (const key of ["near", "eth", "sol", "btc", "base", "arb", "bsc", "tron", "zec", "pol", "avax", "op", "gnosis", "xrp", "doge", "ltc", "bch", "ton", "sui", "ada", "aptos", "stellar", "strk", "abs", "hlevm", "fogo", "bera", "monad", "plasma", "scroll"]) {
    const { logo } = stageView({ legs: [leg(key, "HELD")] }, verdict("anyone")).stops[0];
    assert.ok(have.has(logo), `${key} -> ${logo}`);
  }
});

test("the origin chain is only drawn when the step that names it is proven", () => {
  const v = stageView({ legs: [leg("omni", "INITIALISED", "REPORTED", { facts: { from: "Eth", to: "Sol" } })] }, verdict("omni-relayer"));
  assert.deepEqual(v.stops.map((s) => s.name), ["Omni bridge", "Solana"]);
});

test("place names read as words", () => {
  assert.equal(placeName("sol"), "Solana");
  assert.equal(placeName("nowhere"), "nowhere");
});

test("a proven finished transfer reaches the chain it was heading to", () => {
  const v = stageView({ legs: [leg("omni", "FINALISED", "PROVEN", { facts: { from: "Near", to: "Sol", originProven: true } })] }, verdict("none", "PAID_OUT"));
  assert.deepEqual(v.stops.map((s) => [s.name, s.state, s.label]), [["NEAR", "passed", "sent"], ["Omni bridge", "passed", "finished"], ["Solana", "passed", "arrived"]]);
});

test("a finish that is only reported doesn't reach the destination", () => {
  const v = stageView({ legs: [leg("omni", "FINALISED", "REPORTED", { facts: { to: "Sol" } })] }, verdict("unknown"));
  assert.ok(!v.stops.some((s) => s.label === "arrived"));
});
