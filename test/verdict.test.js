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
test("claims keep only their four fields", async () => {
  const d = caseWith([paidOutLeg], [{ by: "1click", status: "SUCCESS", observedAt: AT, class: "REPORTED", swapDetails: { recipient: "secret" } }]);
  const v = await buildVerdict(d);
  assert.deepEqual(Object.keys(v.claims[0]).sort(), ["by", "class", "observedAt", "status"]);
  assert.ok(!canonicalJson(v).includes("secret"));
});
test("the verdict's legs show provider, status and class", async () =>
  assert.deepEqual((await buildVerdict(c)).legs[0], { provider: "near-intents", status: "PAID_OUT", class: "PROVEN" }));
