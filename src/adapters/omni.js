// An Omni bridge transfer. The indexer can lag, so the destination contract's own record wins when it says paid.
// sign_transfer and fin_transfer are #[trusted_relayer] in Near-One/omni-bridge (near/omni-bridge/src/lib.rs); finTransfer
// on an EVM chain checks the MPC signature and pays only the signed recipient, so anyone may send it.
import { publicPayoutClient } from "../../vendor/wms-core.mjs";
import { failedRead, getJson, postJson } from "../net.js";

const TRANSFERS = "https://mainnet.api.bridge.nearone.org/api/v4/transfers/transfer";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const SOLANA_BRIDGE = "dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe";
const isSolanaSig = (id) => /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(id);
const title = (s) => s[0].toUpperCase() + s.slice(1);
const iso = (sec) => new Date(sec * 1000).toISOString();

const isFinal = (status) => /final|settled|claimed/i.test(status);

export function finishStep({ status, origin, dest }) {
  if (isFinal(status)) return null;
  if (/signed/i.test(status) && dest !== "Near") return { step: "finTransfer", by: "anyone" };
  if (origin === "Near" && dest !== "Near" && !/signed/i.test(status)) return { step: "sign_transfer", by: "omni-relayer" };
  return { step: "fin_transfer", by: "omni-relayer" };
}

async function paidOnContract(t, ctx) {
  if (t.destination_nonce == null || t.destination_chain === "Near") return false;
  const ask = ctx.omniPaid ?? publicPayoutClient(ctx.fetch ?? fetch).omniPaid;
  return (await ask(t.destination_chain.toLowerCase(), t.destination_nonce).catch(() => null)) === true;
}

async function transferToCase(t, ctx) {
  const id = t.transfer_id;
  const ref = `${id.chain}:${id.nonce ?? id.id ?? "?"}`;
  const paid = !isFinal(t.status) && (await paidOnContract(t, ctx));
  const status = paid || isFinal(t.status) ? "FINALISED" : /signed/i.test(t.status) ? "SIGNED" : "INITIALISED";
  const finish = status === "FINALISED" ? null : finishStep({ status: t.status, origin: t.origin_chain, dest: t.destination_chain });
  const tx = t.initialised?.transaction_hash;
  const evidence = tx ? [{ id: `omni:${tx}`, source: t.initialised.chain.toLowerCase(), kind: "tx", ref: tx, observedAt: iso(t.initialised.timestamp_seconds), class: "PROVEN" }] : [];
  evidence.push({ id: `read:omni:${ref}`, source: "omni", kind: "read", ref, observedAt: ctx.now, class: "PROVEN" });
  return {
    legs: [{
      id: `omni:${ref}`, provider: "omni", ref, status, class: "PROVEN", custody: status === "FINALISED" ? "recipient" : "omni bridge", evidence: tx ? [`omni:${tx}`] : [],
      ...(finish ? { finish } : {}),
      facts: { token: t.token_id, amount: t.amount, fee: t.fee, nativeFee: t.native_fee, from: t.origin_chain, to: t.destination_chain },
    }],
    edges: [],
    evidence,
    claims: [],
    identifiers: [ref.toLowerCase(), tx].filter(Boolean),
    next: [],
  };
}

async function solanaCase(sig, ctx) {
  const r = await postJson(SOLANA_RPC, { jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }] }, ctx);
  const tx = r.result;
  const logs = tx?.meta?.logMessages ?? [];
  const bridged = logs.some((l) => l.includes(`${SOLANA_BRIDGE} invoke`)) && logs.some((l) => l.includes("Instruction: InitTransfer"));
  if (!tx || tx.meta.err || !bridged) return { notFound: "No Omni transfer is known for that transaction." };
  return {
    legs: [
      { id: `sol:${sig}`, provider: "sol", ref: sig, status: "DEPOSIT_CONFIRMED", class: "PROVEN", custody: "omni bridge", evidence: [`sol:${sig}`], facts: { slot: tx.slot } },
      { id: `omni:${sig}`, provider: "omni", ref: sig, status: "INITIALISED", class: "INFERRED", custody: "omni bridge", evidence: [], finish: { step: "fin_transfer", by: "omni-relayer" }, facts: { indexerRecord: "none" } },
    ],
    edges: [],
    evidence: [
      { id: `sol:${sig}`, source: "sol", kind: "tx", ref: sig, observedAt: iso(tx.blockTime), class: "PROVEN" },
      { id: `read:omni:${sig}`, source: "omni", kind: "read", ref: sig, observedAt: ctx.now, class: "PROVEN" },
    ],
    claims: [],
    identifiers: [sig],
    next: [],
  };
}

export async function readTransfer(id, ctx) {
  const nonce = /^([a-z]+):(\d+)$/.exec(id);
  const url = nonce ? `${TRANSFERS}?origin_chain=${title(nonce[1])}&origin_nonce=${nonce[2]}` : `${TRANSFERS}?transaction_hash=${encodeURIComponent(id)}`;
  try {
    const r = await getJson(url, ctx);
    const t = r.transfers?.[0];
    if (t) return await transferToCase(t, ctx);
  } catch (e) {
    if (!/answered 404/.test(e.message)) return failedRead("omni", id, e.message, ctx.now);
  }
  if (!isSolanaSig(id)) return { notFound: "No Omni transfer is known for that id." };
  try {
    return await solanaCase(id, ctx);
  } catch (e) {
    return failedRead("sol", id, e.message, ctx.now);
  }
}
