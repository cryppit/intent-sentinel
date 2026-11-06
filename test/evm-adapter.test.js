import test from "node:test";
import assert from "node:assert/strict";
import { readTx } from "../src/adapters/evm.js";

const HASH = "0x" + "a".repeat(64);
const NOW = "2026-11-06T00:00:00Z";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");
const log = { address: "0x" + "c".repeat(40), topics: [TRANSFER, pad("0x" + "1".repeat(40)), pad("0x" + "2".repeat(40))], data: "0x" + (1000).toString(16).padStart(64, "0") };

function stubCtx({ receipt = { status: "0x1", to: "0x" + "c".repeat(40), blockNumber: "0x10", logs: [log] }, code = "0x", dead = false } = {}) {
  return {
    now: NOW,
    fetch: async (url, init) => {
      if (dead) throw new TypeError("fetch failed");
      const { method, id } = JSON.parse(init.body);
      const result = method === "eth_getTransactionReceipt" ? receipt : code;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
    },
  };
}

test("a recipient with code is marked", async () =>
  assert.equal((await readTx("eth", HASH, stubCtx({ code: "0x60" }))).legs[0].facts.recipientIsContract, true));
test("a plain wallet is not", async () =>
  assert.equal((await readTx("eth", HASH, stubCtx())).legs[0].facts.recipientIsContract, false));
test("an ERC-20 transfer gives recipient and amount", async () => {
  const f = (await readTx("eth", HASH, stubCtx())).legs[0].facts;
  assert.equal(f.recipient, "0x" + "2".repeat(40));
  assert.deepEqual(f.transfers, [{ token: "0x" + "c".repeat(40), from: "0x" + "1".repeat(40), to: "0x" + "2".repeat(40), amount: "1000" }]);
});
test("a native transfer's recipient is the tx target", async () =>
  assert.equal((await readTx("eth", HASH, stubCtx({ receipt: { status: "0x1", to: "0x" + "d".repeat(40), blockNumber: "0x10", logs: [] } }))).legs[0].facts.recipient, "0x" + "d".repeat(40)));
test("a reverted tx proves nothing", async () =>
  assert.equal((await readTx("eth", HASH, stubCtx({ receipt: { status: "0x0", to: "0x1", blockNumber: "0x10", logs: [] } }))).legs[0].class, "UNKNOWN"));
test("a dead RPC gives a failed leg, not a throw", async () =>
  assert.equal((await readTx("eth", HASH, stubCtx({ dead: true }))).legs[0].status, "LOOKUP_FAILED"));
test("a hash no node knows gives a failed leg", async () =>
  assert.equal((await readTx("eth", HASH, stubCtx({ receipt: null }))).legs[0].status, "LOOKUP_FAILED"));
test("an unknown chain gives a failed leg", async () =>
  assert.equal((await readTx("nowhere", HASH, stubCtx())).legs[0].status, "LOOKUP_FAILED"));
