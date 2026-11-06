import test from "node:test";
import assert from "node:assert/strict";
import { finishStep, readTransfer } from "../src/adapters/omni.js";

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
  assert.equal(r.legs[0].finish, undefined);
});
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
