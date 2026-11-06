import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { replayCase } from "../src/case.js";
import { canonicalJson } from "../src/canon.js";

const CASES = { "omni-665": ["GATED_FINISH", "omni-relayer"], "omni-666": ["GATED_FINISH", "omni-relayer"], "refund-5btc": ["REFUNDED", "none"] };

for (const [name, [journey, party]] of Object.entries(CASES)) {
  test(`${name} replays twice, byte for byte`, async () => {
    const a = await replayCase(`fixtures/${name}`);
    const b = await replayCase(`fixtures/${name}`);
    assert.equal(canonicalJson(a.verdict), canonicalJson(b.verdict));
    assert.equal(canonicalJson(a.verdict), canonicalJson(JSON.parse(readFileSync(`fixtures/${name}/expected.json`, "utf8"))));
  });
  test(`${name} says ${journey}, next ${party}`, async () => {
    const { verdict } = await replayCase(`fixtures/${name}`);
    assert.equal(verdict.journey, journey);
    assert.equal(verdict.nextAction.party, party);
  });
  test(`${name} holds no 1Click data`, () => {
    const c = JSON.parse(readFileSync(`fixtures/${name}/case.json`, "utf8"));
    assert.ok(!c.claims.some((k) => k.by === "1click"));
  });
}
