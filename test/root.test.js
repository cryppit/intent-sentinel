import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dayRoot, proofFor, verifyProof, pinArgs, checkPin, nearCommand } from "../src/root.js";

const leaf = (n) => createHash("sha256").update(String(n)).digest("hex");
const [a, b, c, d] = [1, 2, 3, 4].map(leaf);
const sha = (...bufs) => { const h = createHash("sha256"); bufs.forEach((x) => h.update(x)); return h.digest(); };
const L = (hex) => sha(Buffer.from([0]), Buffer.from(hex, "hex"));
const N = (l, r) => sha(Buffer.from([1]), l, r);

test("order of verdicts doesn't change the root", async () =>
  assert.equal((await dayRoot([a, b, c])).root, (await dayRoot([c, a, b])).root));
test("the root is RFC 6962, worked out by hand", async () => {
  const [x, y, z] = [a, b, c].sort();
  assert.equal((await dayRoot([a, b, c])).root, N(N(L(x), L(y)), L(z)).toString("hex"));
});
test("one verdict still has a root", async () => {
  const r = await dayRoot([a]);
  assert.equal(r.leafCount, 1);
  assert.equal(r.root, L(a).toString("hex"));
});
test("the same verdict twice counts once", async () => assert.equal((await dayRoot([a, a])).leafCount, 1));
test("no verdicts give the empty root", async () =>
  assert.equal((await dayRoot([])).root, createHash("sha256").digest("hex")));
test("a hash that isn't 64 hex is refused", async () => assert.rejects(() => dayRoot(["nope"])));
for (const n of [1, 2, 3, 4, 5, 7, 8, 9]) {
  test(`every leaf of a ${n}-leaf tree proves`, async () => {
    const hashes = Array.from({ length: n }, (_, i) => leaf(i + 10));
    const { root } = await dayRoot(hashes);
    for (const h of hashes) assert.ok(await verifyProof(h, await proofFor(hashes, h), root), `leaf ${h}`);
  });
}
test("a proof verifies and a changed hash fails", async () => {
  const { root } = await dayRoot([a, b, c]);
  const p = await proofFor([a, b, c], b);
  assert.ok(await verifyProof(b, p, root));
  assert.ok(!(await verifyProof(d, p, root)));
});
test("a proof for a hash not in the day is refused", async () => assert.rejects(() => proofFor([a, b], d)));
test("pin args match the anchor contract", async () => {
  const { root, leafCount } = await dayRoot([a, b]);
  assert.deepEqual(pinArgs("2026-11-06", [a, b], root, leafCount, null), { day: "2026-11-06", head_hash: [a, b].sort().at(-1), merkle_root: root, leaf_count: 2, prev_pin: null });
});
test("the command is printed, never run, and signs nothing itself", () => {
  const cmd = nearCommand("sentinel.cryppit.testnet", { day: "2026-11-06" }, "testnet");
  assert.match(cmd, /^near contract call-function as-transaction sentinel\.cryppit\.testnet pin json-args/);
});
const rpc = (pin) => ({ fetch: async () => new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(pin))] } })) });
test("a pin that holds the root checks out", async () => {
  const { root } = await dayRoot([a, b]);
  const p = await proofFor([a, b], a);
  assert.equal((await checkPin(a, p, "x.testnet", "2026-11-06", "testnet", rpc({ merkle_root: root, leaf_count: 2 }))).ok, true);
});
test("a pin with another root fails", async () => {
  const p = await proofFor([a, b], a);
  assert.equal((await checkPin(a, p, "x.testnet", "2026-11-06", "testnet", rpc({ merkle_root: "0".repeat(64), leaf_count: 2 }))).ok, false);
});
test("no pin for that day fails", async () => {
  const p = await proofFor([a, b], a);
  assert.equal((await checkPin(a, p, "x.testnet", "2026-11-06", "testnet", rpc(null))).ok, false);
});
