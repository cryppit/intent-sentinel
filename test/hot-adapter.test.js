import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hotBurn, hotContract, hotNonce, nestedWithdraw, proveHotPayout, tonAddressOfHotId, tonRawAddress, usedNonceData } from "../src/adapters/hot.js";

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

// A real HOT payout of USDT on TON (a jetton, TON's kind of token): TRON → TON, 8 Nov 2026. HOT burns the USDT on NEAR
// with the nonce as memo; the TON transaction HOT names is the receiver's USDT wallet taking in exactly that amount from
// HOT's own USDT wallet.
const ton = JSON.parse(readFileSync(new URL("./stubs/hot-ton-usdt.json", import.meta.url), "utf8"));
const USDT_ID = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR";
const TON_RECEIVER = "UQBAiSCJ5mqiXeZiT5M_Cuna8LUPppm0554uaRw8ox3F-9od";
const TON_NAMED = ton.hotIndexer.withdrawals[0].hash;
const tonW = { bridge: "hot", chain: "ton", tx: ton.nearTx, token: USDT_ID, amount: "438391666", destination: TON_RECEIVER, timestampNs: 1794122715000000000n };
const tonUnverified = { status: "unverified", chain: "ton", bridge: "hot", destination: TON_RECEIVER, bridgeReport: { source: "hot", status: "COMPLETED", tx: TON_NAMED }, reason: "the token is not recognised on ton" };

/** FastNEAR and toncenter from the recording, with one part changed. */
function tonChains({ tx = (t) => t, wallets = (w) => w, failTon = false } = {}) {
  const calls = [];
  const f = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("fastnear.com/v0/transactions")) return Response.json({ transactions: [ton.near] });
    if (failTon) return new Response("busy", { status: 503 });
    if (u.includes("toncenter.com/api/v3/transactions")) return Response.json({ transactions: ton.tonTx.transactions.map((t) => tx(structuredClone(t))) });
    if (u.includes("toncenter.com/api/v3/jetton/wallets")) return Response.json({ jetton_wallets: ton.jettonWallets.jetton_wallets.map((w) => wallets(structuredClone(w))) });
    return new Response("not stubbed", { status: 404 });
  };
  return { f, calls };
}

test("HOT's burn on NEAR gives the nonce and the amount for a TON token", () =>
  assert.deepEqual(hotBurn(ton.near, "1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR"), { nonce: "1794122716000001860930", amount: "438391666" }));
test("a HOT TON token id names HOT's own token wallet on TON", () =>
  assert.equal(tonAddressOfHotId("1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR"), "0:43686280C90EC0F7343FCE3EFCF3CDCA7525530C00FBDE278CFA320DA95182D4"));
test("a TON address reads the same in its short and raw forms", () => {
  assert.equal(tonRawAddress(TON_RECEIVER), "0:40892089E66AA25DE6624F933F0AE9DAF0B50FA699B4E79E2E691C3CA31DC5FB");
  assert.equal(tonRawAddress("0:40892089e66aa25de6624f933f0ae9daf0b50fa699b4e79e2e691c3ca31dc5fb"), "0:40892089E66AA25DE6624F933F0AE9DAF0B50FA699B4E79E2E691C3CA31DC5FB");
  assert.equal(tonRawAddress("not an address"), null);
});
test("USDT on TON paid through HOT is proven by the named transaction", async () => {
  const p = await proveHotPayout(tonW, tonUnverified, { fetch: tonChains().f });
  assert.equal(p.status, "arrived");
  assert.equal(p.how, "proven");
  assert.equal(p.tx, TON_NAMED);
  assert.equal(p.amount, "438391666");
  assert.equal(p.delaySec, 1794122759 - 1794122715);
});
test("a TON token payout of a different amount is not proof", async () => {
  const p = await proveHotPayout(tonW, tonUnverified, { fetch: tonChains({ tx: (t) => ((t.in_msg.message_content.decoded.amount.value = "438391665"), t) }).f });
  assert.equal(p, tonUnverified);
});
test("a TON token wallet owned by someone else is not proof", async () => {
  const other = "0:" + "1".repeat(64);
  const p = await proveHotPayout(tonW, tonUnverified, { fetch: tonChains({ wallets: (w) => (w.owner.startsWith("0:4089") ? { ...w, owner: other } : w) }).f });
  assert.equal(p, tonUnverified);
});
test("a TON token payout not sent by HOT's token wallet is not proof", async () => {
  const p = await proveHotPayout(tonW, tonUnverified, { fetch: tonChains({ tx: (t) => ((t.in_msg.source = "0:" + "2".repeat(64)), t) }).f });
  assert.equal(p, tonUnverified);
});
test("a TON transaction that failed, or isn't final yet, is not proof", async () => {
  for (const change of [(t) => ((t.description.aborted = true), t), (t) => ((t.finality = "pending"), t), (t) => ((t.emulated = true), t)]) {
    assert.equal(await proveHotPayout(tonW, tonUnverified, { fetch: tonChains({ tx: change }).f }), tonUnverified);
  }
});
test("a TON read that fails leaves the payout as it was", async () =>
  assert.equal(await proveHotPayout(tonW, tonUnverified, { fetch: tonChains({ failTon: true }).f }), tonUnverified));
test("a HOT TON payout HOT names no transaction for is left alone, and TON isn't read", async () => {
  const { f, calls } = tonChains();
  const none = { ...tonUnverified, bridgeReport: { source: "hot", status: "PENDING", tx: null } };
  assert.equal(await proveHotPayout(tonW, none, { fetch: f }), none);
  assert.ok(!calls.some((u) => u.includes("toncenter")));
});
test("toncenter's one-request-a-second limit is waited out once, not read as no payout", async () => {
  const { f } = tonChains();
  let refused = 0;
  const limited = async (url, init) => (String(url).includes("toncenter") && refused++ === 0 ? new Response("slow down", { status: 429 }) : f(url, init));
  const p = await proveHotPayout(tonW, tonUnverified, { fetch: limited });
  assert.equal(p.how, "proven");
});
