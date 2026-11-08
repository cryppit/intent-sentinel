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
test("a failed source is named", () => assert.equal(caseView(failed).legs[1].label, "couldn't check"));
test("known sources link to an explorer", () => {
  assert.equal(explorerUrl("near", "ABC"), "https://nearblocks.io/txns/ABC");
  assert.equal(explorerUrl("eth", "0xabc"), "https://etherscan.io/tx/0xabc");
  assert.equal(explorerUrl("sol", "S1"), "https://solscan.io/tx/S1");
  assert.equal(explorerUrl("btc", "b1"), "https://mempool.space/tx/b1");
});
test("an unknown source has no link", () => assert.equal(explorerUrl("nowhere", "x"), null));

test("claims and balances reach the page", async () => {
  const c = caseWith([{ provider: "x", status: "CREDITED", amountIn: "1", amountOut: ["1"], decimals: 0 }, paidOutLeg], [{ by: "1click", status: "FAILED", observedAt: AT, class: "REPORTED" }]);
  const view = caseView(await buildVerdict(c));
  assert.deepEqual(view.claims, ["1Click (the swap service) says: failed"]);
  assert.match(view.balances[0], /Amounts match/);
});
test("a warning reaches the page", async () => {
  const c = caseWith([paidOutLeg]);
  c.warnings = [{ kind: "locked", party: "near-intents", detail: "locked by operators" }];
  assert.deepEqual(caseView(await buildVerdict(c)).warnings, ["locked by operators"]);
});

test("what to ask for reaches the page", () => {
  const v = caseView({ journey: "GATED_FINISH", nextAction: { party: "omni-relayer", question: "q", evidenceToAsk: ["whether this transfer will be processed"] }, legs: [], claims: [], conservation: [], warnings: [] });
  assert.deepEqual(v.ask, ["whether this transfer will be processed"]);
});

const young = await buildVerdict({ ...caseWith([{ provider: "near-intents", status: "CREDITED" }, { provider: "bsc", status: "PAYOUT_UNSEEN", class: "UNKNOWN", at: AT }]) });
test("a payout still on its way gets its own headline, and still isn't done", () => {
  assert.match(caseView(young).headline, /probably still on its way/);
  assert.equal(caseView(young).tone, "unknown");
});
test("exit codes: a notice is 'not enough evidence', bad input is 1", async () => {
  const { exitCode } = await import("../src/render-text.js");
  assert.equal(exitCode({ error: "x", notice: true }), 3);
  assert.equal(exitCode({ error: "x" }), 1);
  assert.equal(exitCode({ verdict: { journey: "INSUFFICIENT_EVIDENCE", nextAction: { party: "unknown" } } }), 3);
  assert.equal(exitCode({ verdict: { journey: "PAID_OUT", nextAction: { party: "none" } } }), 0);
  assert.equal(exitCode({ verdict: { journey: "GATED_FINISH", nextAction: { party: "omni-relayer" } } }), 2);
});
