import test from "node:test";
import assert from "node:assert/strict";
import { caseView, explorerUrl } from "../src/render-case.js";
import { buildVerdict } from "../src/verdict.js";
import { AT, caseWith, paidOutLeg } from "./helpers.js";

const gated = await buildVerdict(caseWith([{ provider: "omni", status: "INITIALISED", finish: { step: "sign_transfer", by: "omni-relayer" } }]));
const inferred = await buildVerdict(caseWith([{ provider: "near-intents", status: "HELD", class: "INFERRED" }, paidOutLeg]));
const failed = await buildVerdict(caseWith([paidOutLeg, { provider: "omni", status: "LOOKUP_FAILED", class: "UNKNOWN" }]));
const done = await buildVerdict(caseWith([paidOutLeg]));

test("the headline names the next party", () => assert.match(caseView(gated).headline, /omni relayer/i));
test("someone to act is an open tone", () => assert.equal(caseView(gated).tone, "act"));
test("a finished case reads as done", () => assert.equal(caseView(done).tone, "done"));
test("insufficient evidence never looks finished", () => assert.equal(caseView(failed).tone, "unknown"));
test("inferred never reads as proven", () =>
  assert.equal(caseView(inferred).legs.find((l) => l.class === "INFERRED").classLabel, "Inferred"));
test("each class is words, not colour alone", () =>
  assert.deepEqual(caseView(failed).legs.map((l) => l.classLabel), ["Proven", "Unknown"]));
test("a leg says what happened in words", () => assert.equal(caseView(done).legs[0].label, "paid out"));
test("a failed source is named", () => assert.equal(caseView(failed).legs[1].label, "could not be read"));
test("known sources link to an explorer", () => {
  assert.equal(explorerUrl("near", "ABC"), "https://nearblocks.io/txns/ABC");
  assert.equal(explorerUrl("eth", "0xabc"), "https://etherscan.io/tx/0xabc");
  assert.equal(explorerUrl("sol", "S1"), "https://solscan.io/tx/S1");
  assert.equal(explorerUrl("btc", "b1"), "https://mempool.space/tx/b1");
});
test("an unknown source has no link", () => assert.equal(explorerUrl("nowhere", "x"), null));
