import test from "node:test";
import assert from "node:assert/strict";
import { buildVerdict } from "../src/verdict.js";
import { canonicalJson, sha256Hex } from "../src/canon.js";
import { AT, BEFORE, AFTER, caseWith, paidOutLeg } from "./helpers.js";

const c = caseWith([paidOutLeg]);
test("same evidence, same bytes", async () =>
  assert.equal(canonicalJson(await buildVerdict(c)), canonicalJson(await buildVerdict(structuredClone(c)))));
test("changing one fact changes the hash", async () => {
  const altered = structuredClone(c);
  altered.legs[0].status = "REFUNDED";
  assert.notEqual((await buildVerdict(c)).outputHash, (await buildVerdict(altered)).outputHash);
});
test("the hash covers everything but itself", async () => {
  const { outputHash, ...rest } = await buildVerdict(c);
  assert.equal(outputHash, await sha256Hex(canonicalJson(rest)));
});
test("computedAt is the latest evidence, not the clock", async () => {
  const d = structuredClone(c);
  d.evidence.push({ id: "e2", source: "t", kind: "tx", ref: "x", observedAt: AFTER, class: "PROVEN" }, { id: "e3", source: "t", kind: "tx", ref: "y", observedAt: BEFORE, class: "PROVEN" });
  assert.equal((await buildVerdict(d)).computedAt, AFTER);
});
test("a verdict carries the schema and rules version", async () => {
  const v = await buildVerdict(c);
  assert.equal(v.schema, "intent-delivery-verdict/1");
  assert.equal(v.rulesVersion, "1.0.0");
  assert.match(v.incident, /^iv1_/);
});
test("claims keep only who, what and how sure", async () => {
  const d = caseWith([paidOutLeg], [{ by: "1click", status: "SUCCESS", observedAt: AT, class: "REPORTED", swapDetails: { recipient: "secret" } }]);
  const v = await buildVerdict(d);
  assert.deepEqual(Object.keys(v.claims[0]).sort(), ["by", "class", "status"]);
  assert.ok(!canonicalJson(v).includes("secret"));
});
test("the verdict's legs show provider, status and class", async () =>
  assert.deepEqual((await buildVerdict(c)).legs[0], { provider: "near-intents", status: "PAID_OUT", class: "PROVEN" }));

test("reading a case again later doesn't change its hash", async () => {
  const at = (t) => { const d = structuredClone(c); d.evidence.push({ id: "r", source: "t", kind: "read", ref: "x", observedAt: t, class: "PROVEN" }); return d; };
  assert.equal((await buildVerdict(at(AT))).outputHash, (await buildVerdict(at(AFTER))).outputHash);
});
test("a stuck rule still sees when we looked", async () => {
  const d = caseWith([{ provider: "near-intents", status: "HELD", window: { dueBy: AT } }]);
  d.evidence.push({ id: "r", source: "t", kind: "read", ref: "x", observedAt: AFTER, class: "PROVEN" });
  assert.equal((await buildVerdict(d)).journey, "BALANCE_HELD");
});
test("warnings reach the verdict", async () => {
  const d = caseWith([paidOutLeg]);
  d.warnings = [{ kind: "locked", party: "near-intents", detail: "locked by operators" }];
  assert.deepEqual((await buildVerdict(d)).warnings, [{ kind: "locked", detail: "locked by operators" }]);
});
