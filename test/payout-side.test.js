import test from "node:test";
import assert from "node:assert/strict";
import { payoutSide } from "../src/adapters/payout-side.js";

// Made-up hashes; the addresses are the bridges' real public payout wallets and contracts.
const NOW = "2026-11-08T12:00:00Z";
const H = "0x" + "c".repeat(64);
const HEX = "d".repeat(64);
const SIG = "5".repeat(87);
const NEAR_INTENTS_EVM = "0x2cff890f0378a11913b6129b2e97417a2c302680";
const HOT_EVM = "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a) => "0x" + "0".repeat(24) + a.slice(2);
const someone = "0x" + "e".repeat(40);

/** Answers the HOT indexer, EVM JSON-RPC (one chain has the transaction), mempool.space, TronGrid and Solana. */
function sources({ hot = null, evmChain = null, tx = {}, receipt = { status: "0x1", logs: [] }, btc = null, tron = null, sol = null, broken = false } = {}) {
  const asked = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    asked.push(u);
    if (broken) throw new TypeError("fetch failed");
    if (u.includes("bridge-indexer.chaindefuser.com")) return hot ? Response.json(hot) : Response.json({ statusCode: 404, message: "Withdrawal not found" }, { status: 404 });
    if (u.includes("mempool.space")) return btc ? Response.json(btc) : new Response("Transaction not found", { status: 404 });
    if (u.includes("trongrid")) return Response.json(tron ?? {});
    const body = init.body ? JSON.parse(init.body) : {};
    if (body.method === "getTransaction") return Response.json({ jsonrpc: "2.0", id: 1, result: sol });
    if (body.method === "eth_getTransactionByHash") {
      const here = evmChain && u === evmChain;
      return Response.json({ jsonrpc: "2.0", id: 1, result: here ? { hash: H, blockNumber: "0x10", from: someone, to: someone, ...tx } : null });
    }
    if (body.method === "eth_getTransactionReceipt") return Response.json({ jsonrpc: "2.0", id: 1, result: receipt });
    return new Response("not stubbed", { status: 404 });
  };
  return { ctx: { now: NOW, fetch: f }, asked };
}
const ARB = "https://arb1.arbitrum.io/rpc";
const BSC = "https://bsc-dataseed.bnbchain.org";
const PLAIN = /^That's the payout transaction \(money arriving\)\. /;
const ASK = /To check your swap, paste the transaction that sent the money, or the deposit address\.$/;

test("a payout HOT's records know leads back to its NEAR transaction", async () => {
  const { ctx } = sources({ hot: { near_trx: "2srP55JNGt59TyWNtFb62yfjndkYpfxtZ534At2irt3B", withdrawals: [{ bridge: "HOT", hash: H, blockchain: "bsc" }] } });
  assert.deepEqual(await payoutSide({ kind: "evm-tx", value: H }, ctx), { nearTx: "2srP55JNGt59TyWNtFb62yfjndkYpfxtZ534At2irt3B", chain: "bsc", by: "the HOT bridge" });
});
test("HOT's record for another transaction is not taken", async () => {
  const { ctx } = sources({ hot: { near_trx: "2srP55JNGt59TyWNtFb62yfjndkYpfxtZ534At2irt3B", withdrawals: [{ bridge: "HOT", hash: "0x" + "1".repeat(64) }] } });
  assert.equal(await payoutSide({ kind: "evm-tx", value: H }, ctx), null);
});
test("an EVM transaction sent by NEAR Intents' payout wallet is a payout, in plain words", async () => {
  const { ctx } = sources({ evmChain: ARB, tx: { from: NEAR_INTENTS_EVM } });
  const r = await payoutSide({ kind: "evm-tx", value: H }, ctx);
  assert.match(r.notice, PLAIN);
  assert.match(r.notice, /NEAR Intents sent it on Arbitrum/);
  assert.match(r.notice, ASK);
});
test("a token paid out by HOT's contract inside another call is a payout", async () => {
  const log = { address: someone, topics: [TRANSFER, topic(HOT_EVM), topic(someone)], data: "0x1" };
  const { ctx } = sources({ evmChain: BSC, receipt: { status: "0x1", logs: [log] } });
  assert.match((await payoutSide({ kind: "evm-tx", value: H }, ctx)).notice, /The HOT bridge sent it on BNB Chain/);
});
test("an ordinary EVM transaction is not called a payout", async () => {
  const { ctx } = sources({ evmChain: ARB });
  assert.equal(await payoutSide({ kind: "evm-tx", value: H }, ctx), null);
});
test("a Bitcoin payout from NEAR Intents' wallet is a payout", async () => {
  const { ctx } = sources({ btc: { txid: HEX, vin: [{ prevout: { scriptpubkey_address: "1C6XJtNXiuXvk4oUAVMkKF57CRpaTrN5Ra" } }], vout: [] } });
  assert.match((await payoutSide({ kind: "hex-tx", value: HEX }, ctx)).notice, /NEAR Intents sent it on Bitcoin/);
});
test("a TRON payout from NEAR Intents' wallet is a payout", async () => {
  const { ctx } = sources({ tron: { txID: HEX, raw_data: { contract: [{ parameter: { value: { owner_address: "41e78cc21a0dfb6e840d52652224493b60d02ed628" } } }] } } });
  assert.match((await payoutSide({ kind: "hex-tx", value: HEX }, ctx)).notice, /NEAR Intents sent it on TRON/);
});
test("a Solana payout paid for by NEAR Intents' wallet is a payout", async () => {
  const { ctx } = sources({ sol: { transaction: { message: { accountKeys: ["HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16", someone] } } } });
  assert.match((await payoutSide({ kind: "solana-tx", value: SIG }, ctx)).notice, /NEAR Intents sent it on Solana/);
});
test("sources that don't answer give no answer, never a throw", async () => {
  const { ctx } = sources({ broken: true });
  for (const id of [{ kind: "evm-tx", value: H }, { kind: "hex-tx", value: HEX }, { kind: "solana-tx", value: SIG }]) assert.equal(await payoutSide(id, ctx), null);
});
test("a NEAR transaction or an address is not looked up as a payout", async () => {
  const { ctx, asked } = sources();
  assert.equal(await payoutSide({ kind: "near-tx", value: "x" }, ctx), null);
  assert.equal(await payoutSide({ kind: "deposit-address", value: someone }, ctx), null);
  assert.deepEqual(asked, []);
});
