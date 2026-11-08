import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hotContract, hotNonce, nestedWithdraw, proveHotPayout, usedNonceData } from "../src/adapters/hot.js";

// A real HOT payout: a TON → BSC swap on 8 Nov 2026 paid native BNB through an ERC-4337 EntryPoint, with HOT's
// withdraw call nested inside, so a reader that only looks at the outer call misses it.
const rec = JSON.parse(readFileSync(new URL("./stubs/hot-bsc.json", import.meta.url), "utf8"));
const NONCE = "1794120666000001860912";
const RECEIVER = "0x25a2d8e5fc10d8a85523b37ca98fbaaf7bc63727";
const hotW = { bridge: "hot", chain: "bsc", tx: rec.nearTx, destination: RECEIVER };
const unverified = { status: "unverified", chain: "bsc", bridge: "hot", destination: RECEIVER, bridgeReport: { source: "hot", status: "COMPLETED", tx: rec.bscTx.hash } };

/** A fetch that answers FastNEAR's transaction call and BSC JSON-RPC from the recording, with overrides. */
function chains({ used = true, receiptStatus = rec.bscReceipt.status, input = rec.bscTx.input, failNear = false } = {}) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.method ?? "near-tx");
    if (String(url).includes("fastnear.com/v0/transactions")) {
      if (failNear) return new Response("down", { status: 503 });
      return Response.json({ transactions: [rec.near] });
    }
    const result = {
      eth_call: `0x${(used ? 1 : 0).toString(16).padStart(64, "0")}`,
      eth_getTransactionByHash: { ...rec.bscTx, input },
      eth_getTransactionReceipt: { ...rec.bscReceipt, status: receiptStatus },
    }[body.method];
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
  return { f, calls };
}

test("the HOT nonce is the memo on HOT's own burn, not intents.near's", () => assert.equal(hotNonce(rec.near), NONCE));
test("no HOT burn means no nonce", () => assert.equal(hotNonce({ receipts: [] }), null));
test("usedNonces(uint128) is asked with the nonce as one word", () =>
  assert.equal(usedNonceData(NONCE), `0xfd82f7fd${BigInt(NONCE).toString(16).padStart(64, "0")}`));
test("ADI's HOT contract differs from the other EVM chains", () => {
  assert.equal(hotContract("bsc"), "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd");
  assert.equal(hotContract("adi"), "0x4a3b9d07a9a1e3d9dfb0a6edfc87384f8f424003");
  assert.equal(hotContract("ton"), null);
});
test("a withdraw call nested inside another call is found by its nonce", () =>
  assert.deepEqual(nestedWithdraw(rec.bscTx.input, NONCE), { token: "0x0000000000000000000000000000000000000000", receiver: RECEIVER, amount: 135830661787248n }));
test("a nested withdraw for another nonce is not taken", () => assert.equal(nestedWithdraw(rec.bscTx.input, "1"), null));

test("a used nonce plus the named transaction proves the payout", async () => {
  const p = await proveHotPayout(hotW, unverified, { fetch: chains().f });
  assert.equal(p.status, "arrived");
  assert.equal(p.how, "proven");
  assert.equal(p.tx, rec.bscTx.hash);
  assert.equal(p.amount, "135830661787248");
});
test("a nonce the contract hasn't used leaves the payout unproven", async () => {
  const p = await proveHotPayout(hotW, unverified, { fetch: chains({ used: false }).f });
  assert.equal(p.status, "unverified");
});
test("a used nonce alone is recorded as paid, without naming a transaction", async () => {
  const p = await proveHotPayout(hotW, unverified, { fetch: chains({ receiptStatus: "0x0" }).f });
  assert.equal(p.status, "arrived");
  assert.equal(p.how, "recorded");
  assert.equal(p.tx, null);
});
test("a named transaction paying someone else is not used as proof", async () => {
  const other = rec.bscTx.input.replace(RECEIVER.slice(2), "1".repeat(40));
  const p = await proveHotPayout(hotW, unverified, { fetch: chains({ input: other }).f });
  assert.equal(p.how, "recorded");
  assert.equal(p.tx, null);
});
test("a payout already proven, or not on HOT, is left alone and nothing is read", async () => {
  const { f, calls } = chains();
  const done = { status: "arrived", how: "proven", tx: "0xabc" };
  assert.equal(await proveHotPayout(hotW, done, { fetch: f }), done);
  assert.equal(await proveHotPayout({ ...hotW, bridge: "omni" }, unverified, { fetch: f }), unverified);
  assert.deepEqual(calls, []);
});
test("a NEAR read that fails leaves the payout as it was, never as paid", async () => {
  const p = await proveHotPayout(hotW, unverified, { fetch: chains({ failNear: true }).f });
  assert.equal(p, unverified);
});

test("a NEAR Intents order paid through HOT reads as paid out and proven", async () => {
  const { withHotProof, traceToLegs } = await import("../src/adapters/near.js");
  const report = {
    account: "order.example", verdict: "settled", origin: { status: "proven", kind: "poa", chain: "ton", txHash: "ORIGIN", how: "test" },
    deposits: [{ status: "proven", tx: "NEARCREDIT", timestampNs: 1794120627000000000n, height: 1, token: "nep141:ton", amount: "1" }],
    swaps: [], transfers: [], balances: {}, flags: [], resolvedVia: "transaction",
    withdrawals: [{ status: "proven", tx: rec.nearTx, timestampNs: 1794120665128387298n, height: 2, kind: "mt_withdraw", token: "nep245:v2_1.omni.hot.tg:56_11111111111111111111", amount: "148830661787248", chain: "bsc", bridge: "hot", destination: RECEIVER }],
    payout: unverified,
  };
  const proved = await withHotProof(report, { fetch: chains().f });
  const end = traceToLegs(proved, "2026-11-08T07:00:00Z").legs.at(-1);
  assert.equal(end.status, "PAID_OUT");
  assert.equal(end.class, "PROVEN");
  assert.equal(end.ref, rec.bscTx.hash);
});
test("a proven HOT payout is followed up with its known receiver", async () => {
  const { withHotProof, traceToLegs } = await import("../src/adapters/near.js");
  const report = {
    account: "o", verdict: "settled", origin: { status: "missing" }, deposits: [], swaps: [], transfers: [], balances: {}, flags: [], resolvedVia: "transaction",
    withdrawals: [{ status: "proven", tx: rec.nearTx, timestampNs: 1794120665128387298n, height: 2, kind: "mt_withdraw", token: "t", amount: "1", chain: "bsc", bridge: "hot", destination: RECEIVER }],
    payout: unverified,
  };
  const next = traceToLegs(await withHotProof(report, { fetch: chains().f }), "2026-11-08T07:00:00Z").next;
  assert.deepEqual(next, [{ kind: "evm-tx", chain: "bsc", value: rec.bscTx.hash, recipient: RECEIVER }]);
});
