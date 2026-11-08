import test from "node:test";
import assert from "node:assert/strict";
import { finishStep, readTransfer } from "../src/adapters/omni.js";
import { readFileSync } from "node:fs";
import { SOLANA_RPCS, solanaTransaction } from "../src/adapters/solana.js";

const NOW = "2026-11-06T00:00:00Z";
const SIG = "3hd4Kzyd7VHQbNpgWamqznJtm9cTyAVhYVA751B8XUtPXQ4M1YpZBNx1gWnHuT1LEW11kttjRAK5geWRgKw7ppE5";
const v4 = (over = {}) => ({
  transfer_id: { type: "nonce", chain: "Near", nonce: 7 }, origin_chain: "Near", destination_chain: "Eth", sender: "near:a", recipient: "eth:0xb",
  token_id: "near:eth.bridge.near", amount: "20", fee: "0", native_fee: "1", destination_nonce: 9, status: "Initialised",
  initialised: { transaction_hash: "INIT", chain: "Near", timestamp_seconds: 1790590583 }, signed: [], ...over,
});
const res = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const nearOk = { execution_outcome: { outcome: { status: { SuccessValue: "" } } }, receipts: [] };
const ctxFor = ({ transfer, paid = false, dead = false, solana, nearTx = nearOk } = {}) => ({
  now: NOW,
  omniPaid: async () => paid,
  fetch: async (url) => {
    if (dead) throw new TypeError("fetch failed");
    if (String(url).includes("solana")) return res({ result: solana ?? null });
    if (String(url).includes("mempool.space")) return res({ confirmed: true });
    if (String(url).includes("fastnear")) return res({ transactions: nearTx ? [nearTx] : [] });
    return transfer ? res({ transfers: [transfer] }) : res("Not found", 404);
  },
});
const solanaTx = (logs, err = null) => ({ slot: 5, blockTime: 1791143959, meta: { err, logMessages: logs } });
const OMNI_LOGS = ["Program dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe invoke [1]", "Program log: Instruction: InitTransfer"];

test("fee 0 from NEAR needs a relayer to sign", () =>
  assert.deepEqual(finishStep({ status: "Initialised", origin: "Near", fee: "0" }), { step: "sign_transfer", by: "omni-relayer" }));
test("once signed, anyone can finish on Ethereum", () =>
  assert.deepEqual(finishStep({ status: "Signed", origin: "Near", dest: "Eth" }), { step: "finTransfer", by: "anyone" }));
test("fee 0 into NEAR is gated on fin_transfer", () =>
  assert.deepEqual(finishStep({ status: "Initialised", origin: "Sol", dest: "Near", fee: "0" }), { step: "fin_transfer", by: "omni-relayer" }));
test("a finished transfer has no next step", () => assert.equal(finishStep({ status: "Finalised", origin: "Near", dest: "Eth" }), null));

test("an initialised transfer is a gated leg", async () => {
  const r = await readTransfer("near:7", ctxFor({ transfer: v4() }));
  assert.equal(r.legs[0].status, "INITIALISED");
  assert.equal(r.legs[0].ref, "Near:7");
  assert.deepEqual(r.legs[0].finish, { step: "sign_transfer", by: "omni-relayer" });
  assert.equal(r.legs[0].facts.fee, "0");
});
test("the contract beats a lagging indexer", async () => {
  const r = await readTransfer("near:7", ctxFor({ transfer: v4({ status: "Signed" }), paid: true }));
  assert.equal(r.legs[0].status, "FINALISED");
  assert.equal(r.legs[0].class, "PROVEN");
  assert.equal(r.legs[0].finish, undefined);
});
test("a contract view makes the unpaid state proven", async () =>
  assert.equal((await readTransfer("near:7", ctxFor({ transfer: v4() }))).legs[0].class, "PROVEN"));
test("with no contract to read, the indexer is only a report", async () => {
  const r = await readTransfer("near:7", ctxFor({ transfer: v4({ destination_chain: "Near", origin_chain: "Sol" }) }));
  assert.equal(r.legs[0].class, "REPORTED");
});
test("a contract that can't be read is a failed read, not a clean answer", async () => {
  const r = await readTransfer("near:7", { ...ctxFor({ transfer: v4({ status: "Signed" }) }), omniPaid: async () => null });
  assert.ok(r.legs.some((l) => l.status === "LOOKUP_FAILED"));
});
test("BNB reaches the tracer under its own chain key", async () => {
  let asked = null;
  await readTransfer("near:7", { ...ctxFor({ transfer: v4({ destination_chain: "Bnb" }) }), omniPaid: async (c) => { asked = c; return false; } });
  assert.equal(asked, "bsc");
});
test("the contract view is not a dated event", async () =>
  assert.ok((await readTransfer("near:7", ctxFor({ transfer: v4() }))).evidence.every((e) => e.kind !== "read" || e.observedAt === NOW)));
test("a transfer's chain time becomes evidence", async () =>
  assert.equal((await readTransfer("near:7", ctxFor({ transfer: v4() }))).evidence[0].observedAt, "2026-09-28T10:16:23.000Z"));
test("a dead indexer gives a failed leg", async () =>
  assert.equal((await readTransfer("near:7", ctxFor({ dead: true }))).legs[0].status, "LOOKUP_FAILED"));
test("an unknown transfer is a plain answer", async () => assert.ok((await readTransfer("near:7", ctxFor())).notFound));

test("a Solana bridge deposit the indexer never saw is proven at source, inferred after", async () => {
  const r = await readTransfer(SIG, ctxFor({ solana: solanaTx(OMNI_LOGS) }));
  assert.deepEqual(r.legs.map((l) => [l.status, l.class]), [["DEPOSIT_CONFIRMED", "PROVEN"], ["INITIALISED", "INFERRED"]]);
  assert.deepEqual(r.legs[1].finish, { step: "fin_transfer", by: "omni-relayer" });
});
test("a Solana tx that isn't the bridge's is not a case", async () =>
  assert.ok((await readTransfer(SIG, ctxFor({ solana: solanaTx(["Program 1111 invoke [1]"]) }))).notFound));
test("a failed Solana tx is not a deposit", async () =>
  assert.ok((await readTransfer(SIG, ctxFor({ solana: solanaTx(OMNI_LOGS, { InstructionError: [0, "Custom"] }) }))).notFound));

const settled = (dest, tx = "DEST") => v4({ destination_chain: dest, status: "Settled", finalised: { transaction_hash: tx, chain: dest, timestamp_seconds: 1790590606 } });
test("a finish to Solana is proven by its transaction", async () => {
  const r = await readTransfer("near:7", ctxFor({ transfer: settled("Sol"), solana: solanaTx([]) }));
  assert.deepEqual([r.legs[0].status, r.legs[0].class], ["FINALISED", "PROVEN"]);
  assert.ok(r.evidence.some((e) => e.ref === "DEST" && e.class === "PROVEN" && e.observedAt === "2026-09-28T10:16:46.000Z"));
});
test("a finish to Bitcoin is proven by its confirmation", async () =>
  assert.equal((await readTransfer("near:7", ctxFor({ transfer: settled("Btc") }))).legs[0].class, "PROVEN"));
test("a finish into NEAR is proven by its transaction", async () =>
  assert.equal((await readTransfer("sol:7", ctxFor({ transfer: settled("Near") }))).legs[0].class, "PROVEN"));
test("a finish whose transaction can't be read stays reported", async () =>
  assert.equal((await readTransfer("near:7", ctxFor({ transfer: settled("Sol") }))).legs[0].class, "REPORTED"));
test("a failed destination transaction doesn't prove a finish", async () =>
  assert.equal((await readTransfer("near:7", ctxFor({ transfer: settled("Sol"), solana: solanaTx([], { InstructionError: [0, "x"] }) }))).legs[0].class, "REPORTED"));

const rpcCtx = (answers) => {
  const asked = [];
  return { asked, now: NOW, fetch: async (url) => {
    asked.push(String(url));
    const a = answers[SOLANA_RPCS.indexOf(String(url))];
    return a === "refused" ? res({ error: "Access forbidden" }, 403) : res({ result: a });
  } };
};

test("a Solana read moves past an endpoint that refuses it", async () => {
  const ctx = rpcCtx(["refused", { slot: 1 }, null]);
  assert.deepEqual(await solanaTransaction("SIG", ctx), { slot: 1 });
  assert.equal(new Set(ctx.asked).size, 2);
});

test("a Solana read moves past a node that has dropped an old transaction", async () => {
  const ctx = rpcCtx([null, { slot: 1 }, null]);
  assert.deepEqual(await solanaTransaction("SIG", ctx), { slot: 1 });
});

test("a transaction every Solana endpoint says is missing is missing", async () =>
  assert.equal(await solanaTransaction("SIG", rpcCtx([null, null, null])), null));

test("a Solana endpoint that refused means absence isn't proven", async () =>
  assert.rejects(solanaTransaction("SIG", rpcCtx([null, null, "refused"]))));

test("the page may reach every Solana endpoint", () => {
  const html = readFileSync("index.html", "utf8");
  for (const url of SOLANA_RPCS) assert.ok(html.includes(url), url);
});

const failedNear = { execution_outcome: { outcome: { status: { SuccessReceiptId: "R" } } }, receipts: [{ execution_outcome: { outcome: { status: { Failure: { ActionError: {} } } } } }] };

test("a NEAR finish whose transaction failed doesn't prove anything", async () => {
  const r = await readTransfer("near:7", ctxFor({ transfer: settled("Near"), nearTx: failedNear }));
  assert.equal(r.legs[0].class, "REPORTED");
});

test("a start the chain can't confirm is reported, not proven", async () => {
  const r = await readTransfer("near:7", ctxFor({ transfer: v4(), nearTx: null }));
  assert.equal(r.legs[0].class, "REPORTED");
  assert.equal(r.evidence.find((e) => e.kind === "tx").class, "REPORTED");
  assert.equal(r.legs[0].facts.originProven, false);
});

test("a start the chain confirms is proven", async () => {
  const r = await readTransfer("near:7", ctxFor({ transfer: v4() }));
  assert.equal(r.legs[0].class, "PROVEN");
  assert.equal(r.legs[0].facts.originProven, true);
});

test("a transfer with no start on record is never proven by an unpaid contract", async () => {
  const r = await readTransfer("near:7", ctxFor({ transfer: v4({ initialised: null }) }));
  assert.equal(r.legs[0].class, "REPORTED");
});

test("signed with no signing transaction stays reported, even when the contract is unpaid", async () => {
  const r = await readTransfer("near:7", ctxFor({ transfer: v4({ status: "Signed", signed: [] }) }));
  assert.equal(r.legs[0].class, "REPORTED");
});

for (const [name, nearTx] of [["no outcome at all", {}], ["an unknown status", { execution_outcome: { outcome: { status: "Unknown" } }, receipts: [] }], ["a receipt with no status", { execution_outcome: nearOk.execution_outcome, receipts: [{}] }]]) {
  test(`a NEAR read with ${name} proves nothing`, async () => {
    const r = await readTransfer("near:7", ctxFor({ transfer: settled("Near"), nearTx }));
    assert.equal(r.legs[0].class, "REPORTED");
  });
}

test("a Btc finish with no chain time is marked undated", async () => {
  const r = await readTransfer("near:7", ctxFor({ transfer: v4({ destination_chain: "Btc", status: "Settled", utxo_winning_tx_hash: "DEST", finalised: null }) }));
  assert.equal(r.evidence.find((e) => e.ref === "DEST").undated, true);
});

// EVM reads for the destination chain: a receipt with an optional ERC-20 Transfer to the recipient.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");
const RECIPIENT = "0x" + "b".repeat(40);
const evmCtx = (transfer, { paid = false, payTo = RECIPIENT, ok = true } = {}) => ({
  now: NOW,
  omniPaid: async () => paid,
  fetch: async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (body?.method === "eth_getTransactionReceipt") {
      const logs = payTo ? [{ address: "0x" + "c".repeat(40), topics: [TRANSFER_TOPIC, word("0x" + "1".repeat(40)), word(payTo)], data: word("13") }] : [];
      return res({ jsonrpc: "2.0", id: body.id, result: { status: ok ? "0x1" : "0x0", to: "0x" + "c".repeat(40), blockNumber: "0x10", logs } });
    }
    if (body?.method === "eth_getCode") return res({ jsonrpc: "2.0", id: body.id, result: "0x" });
    if (String(url).includes("fastnear")) return res({ transactions: [nearOk] });
    return res({ transfers: [transfer] });
  },
});
const fast = (over = {}) => v4({ status: "Signed", recipient: `eth:${RECIPIENT}`, fast_finalised: { transaction_hash: "0xfast", chain: "Eth", timestamp_seconds: 1790590683 }, ...over });

test("an Avalanche transfer isn't a failed read just because we know no contract there", async () => {
  const r = await readTransfer("near:7", evmCtx(v4({ destination_chain: "Avax", status: "Signed" })));
  assert.ok(!r.legs.some((l) => l.status === "LOOKUP_FAILED"));
});
test("a finished Avalanche transfer is proven by its destination transaction", async () => {
  const t = v4({ destination_chain: "Avax", status: "Finalised", finalised: { transaction_hash: "0xdone", chain: "Avax", timestamp_seconds: 1790590683 } });
  const r = await readTransfer("near:7", evmCtx(t));
  assert.equal(r.legs[0].status, "FINALISED");
  assert.equal(r.legs[0].class, "PROVEN");
});
test("a fast transfer that already paid the recipient never says a relayer must act", async () => {
  const r = await readTransfer("near:7", evmCtx(fast()));
  assert.equal(r.legs[0].status, "FINALISED");
  assert.equal(r.legs[0].finish, undefined);
  assert.equal(r.legs[0].class, "PROVEN");
  assert.equal(r.legs[0].facts.fast, true);
  assert.ok(r.evidence.some((e) => e.ref === "0xfast" && e.class === "PROVEN"));
});
test("a fast transfer whose transaction pays someone else is only reported", async () => {
  const r = await readTransfer("near:7", evmCtx(fast(), { payTo: "0x" + "9".repeat(40) }));
  assert.equal(r.legs[0].status, "FINALISED");
  assert.equal(r.legs[0].class, "REPORTED");
  assert.equal(r.legs[0].finish, undefined);
});
