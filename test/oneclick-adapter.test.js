import test from "node:test";
import assert from "node:assert/strict";
import { readClaim, readStatus } from "../src/adapters/oneclick.js";
import { canonicalJson } from "../src/canon.js";

const ctx = (body, status = 200) => ({ now: "2026-11-06T00:00:00Z", fetch: async () => new Response(JSON.stringify(body), { status }) });

test("a 1Click reply is reduced to its category", async () => {
  const c = await readClaim("addr", ctx({ status: "SUCCESS", swapDetails: { recipient: "secret", amountOut: "9" } }));
  assert.deepEqual(Object.keys(c).sort(), ["by", "class", "observedAt", "status"]);
  assert.ok(!canonicalJson(c).includes("secret"));
});
for (const [word, category] of [["PENDING_DEPOSIT", "PENDING"], ["KNOWN_DEPOSIT_TX", "PENDING"], ["INCOMPLETE_DEPOSIT", "PENDING"], ["PROCESSING", "PENDING"], ["FAILED", "FAILED"], ["REFUNDED", "REFUNDED"]])
  test(`${word} reads as ${category}`, async () => assert.equal((await readClaim("addr", ctx({ status: word }))).status, category));
test("a word we don't know stays unknown", async () => assert.equal((await readClaim("addr", ctx({ status: "NEW" }))).status, "UNKNOWN"));
test("no answer is no claim, and nothing breaks", async () => assert.equal(await readClaim("addr", ctx({}, 404)), null));

test("the status also gives the on-chain link to follow, in memory", async () =>
  assert.equal((await readStatus("addr", ctx({ status: "REFUNDED", swapDetails: { nearTxHashes: ["NEARHASH"], recipient: "secret" } }))).nearTx, "NEARHASH"));
test("no answer gives nothing to follow", async () => assert.equal(await readStatus("addr", ctx({}, 404)), null));
