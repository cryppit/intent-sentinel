import test from "node:test";
import assert from "node:assert/strict";
import { buildPacket, packetHash, verifyPacket } from "../src/packet.js";
import { renderText } from "../src/render-text.js";
import { buildVerdict } from "../src/verdict.js";
import { canonicalJson } from "../src/canon.js";
import { AT, BEFORE, caseWith, paidOutLeg } from "./helpers.js";

const claim = { by: "1click", status: "SUCCESS", observedAt: AT, class: "REPORTED", swapDetails: { recipient: "secret" } };
const base = caseWith([paidOutLeg], [claim]);
base.evidence.push(
  { id: "e0", source: "near", kind: "tx", ref: "OLD", observedAt: BEFORE, class: "PROVEN" },
  { id: "r1", source: "1click", kind: "status", ref: "x", observedAt: AT, class: "REPORTED" },
  { id: "r2", source: "near", kind: "read", ref: "acct", observedAt: AT, class: "PROVEN" },
);
const v = await buildVerdict(base);

test("a packet holds proven evidence only", () =>
  assert.ok(buildPacket(base, v).evidence.every((e) => e.class === "PROVEN")));
test("no 1Click payload survives", () => {
  const p = buildPacket(base, v);
  assert.ok(!canonicalJson(p).includes("secret"));
  assert.ok(!canonicalJson(p).includes("swapDetails"));
  assert.deepEqual(Object.keys(p.verdict.claims[0]).sort(), ["by", "class", "status"]);
});
test("the timeline runs oldest first and skips our own reads", () =>
  assert.deepEqual(buildPacket(base, v).timeline.map((t) => t.ref), ["OLD", "r"]));
test("a finished case has no open question", () =>
  assert.deepEqual(buildPacket(caseWith([paidOutLeg]), { ...v, nextAction: { party: "none", question: null, evidenceToAsk: [] } }).openQuestions, []));
test("an open case carries its question", async () => {
  const c = caseWith([{ provider: "omni", status: "INITIALISED", finish: { step: "sign_transfer", by: "omni-relayer" } }]);
  assert.equal(buildPacket(c, await buildVerdict(c)).openQuestions.length, 1);
});
test("inferred text says so", async () => {
  const c = caseWith([{ provider: "near-intents", status: "HELD", class: "INFERRED" }]);
  assert.match(renderText(await buildVerdict(c)), /inferred/i);
});
test("who acts next comes first", async () => {
  const c = caseWith([{ provider: "omni", status: "INITIALISED", finish: { step: "sign_transfer", by: "omni-relayer" } }]);
  assert.match(renderText(await buildVerdict(c)).split("\n")[0], /an Omni relayer/);
});
test("nobody to act says it's finished", async () => assert.match(renderText(await buildVerdict(caseWith([paidOutLeg]))).split("\n")[0], /nothing left/i));
test("an unreadable source says so, and doesn't look finished", async () => {
  const c = caseWith([paidOutLeg, { provider: "omni", status: "LOOKUP_FAILED", class: "UNKNOWN" }]);
  assert.match(renderText(await buildVerdict(c)), /could not read omni/i);
});

test("a true packet checks out", async () => assert.equal(await verifyPacket(buildPacket(base, v)), true));
test("a changed verdict is caught even with its old hash", async () => {
  const p = structuredClone(buildPacket(base, v));
  p.verdict.journey = "REFUNDED";
  assert.equal(await verifyPacket(p), false);
});
test("the packet hash covers the evidence too", async () => {
  const p = buildPacket(base, v);
  const q = structuredClone(p);
  q.evidence[0].ref = "changed";
  assert.notEqual(await packetHash(p), await packetHash(q));
});
test("warnings are printed", async () => {
  const c = caseWith([paidOutLeg]);
  c.warnings = [{ kind: "locked", party: "near-intents", detail: "locked by operators" }];
  assert.match(renderText(await buildVerdict(c)), /locked by operators/);
});
test("a balance not checked says so", async () =>
  assert.match(renderText(await buildVerdict(caseWith([{ provider: "x", status: "CREDITED", unchecked: "a swap changes the token" }, paidOutLeg]))), /not checked/));
