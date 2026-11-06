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
const ctxFor = ({ transfer, paid = false, dead = false, solana } = {}) => ({
  now: NOW,
  omniPaid: async () => paid,
  fetch: async (url) => {
    if (dead) throw new TypeError("fetch failed");
    if (String(url).includes("solana")) return res({ result: solana ?? null });
    if (String(url).includes("mempool.space")) return res({ confirmed: true });
    if (String(url).includes("fastnear")) return res({ transactions: [{ transaction: { hash: "DEST" } }] });
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
