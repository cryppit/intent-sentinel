// An Omni bridge transfer. The indexer can lag, so the destination contract's own record wins when it says paid.
// sign_transfer and fin_transfer are #[trusted_relayer] in Near-One/omni-bridge (near/omni-bridge/src/lib.rs); finTransfer
// on an EVM chain checks the MPC signature and pays only the signed recipient, so anyone may send it.
import { publicPayoutClient } from "../../vendor/wms-core.mjs";
import { failedRead, getJson, noStore, postJson } from "../net.js";
import { readTx } from "./evm.js";
import { solanaTransaction } from "./solana.js";

const TRANSFERS = "https://mainnet.api.bridge.nearone.org/api/v4/transfers/transfer";
const MEMPOOL = "https://mempool.space/api";
const FASTNEAR_TX = "https://tx.main.fastnear.com/v0/transactions";
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

/** The tracer's chain key for each destination whose bridge contract records a finished transfer. Avalanche and
 * Abstract aren't here: no Omni contract is known for them, so they're read through their transactions instead. */
const CONTRACT_CHAIN = { Eth: "eth", Base: "base", Arb: "arb", Bnb: "bsc", Pol: "pol", HlEvm: "hlevm", Strk: "starknet" };
/** Destination chains whose transactions are read through the EVM reader. */
const EVM_CHAIN = { Eth: "eth", Base: "base", Arb: "arb", Bnb: "bsc", Pol: "pol", Avax: "avax", HlEvm: "hlevm", Abs: "abs" };
const bare = (address) => String(address ?? "").replace(/^[a-z]+:/i, "").toLowerCase();

/** true or false from the destination contract; null if it can't be read; undefined if there's no contract to ask. */
async function paidOnContract(t, ctx) {
  const chain = CONTRACT_CHAIN[t.destination_chain];
  if (!chain || t.destination_nonce == null) return undefined;
  const ask = ctx.omniPaid ?? publicPayoutClient(noStore(ctx.fetch ?? fetch)).omniPaid;
  return ask(chain, t.destination_nonce).catch(() => null);
}

const destinationTx = (t) => t.utxo_winning_tx_hash ?? t.finalised?.transaction_hash ?? null;

async function nearTxSucceeded(tx, ctx) {
  const found = (await postJson(FASTNEAR_TX, { tx_hashes: [tx] }, ctx)).transactions?.[0];
  if (!found) return false;
  const outcomes = [found.execution_outcome, ...(found.receipts ?? []).map((r) => r.execution_outcome)];
  const succeeded = (o) => ["SuccessValue", "SuccessReceiptId"].some((k) => Object.hasOwn(Object(o?.outcome?.status), k));
  return outcomes.every(succeeded);
}

/** True only when the chain itself shows the transaction succeeded. Chains we can't read here stay false. */
async function onChain(chain, tx, ctx) {
  if (!tx) return false;
  try {
    if (chain === "Sol") {
      const found = await solanaTransaction(tx, ctx);
      return Boolean(found) && found.meta?.err === null;
    }
    if (chain === "Btc") return (await getJson(`${MEMPOOL}/tx/${tx}/status`, ctx)).confirmed === true;
    if (chain === "Near") return await nearTxSucceeded(tx, ctx);
    if (EVM_CHAIN[chain]) return (await readTx(EVM_CHAIN[chain], tx, ctx)).legs?.[0]?.class === "PROVEN";
  } catch {
    return false;
  }
  return false;
}

/** A fast relayer's payout: its transaction succeeded and moved a token to the recipient. Native-coin payouts can't be
 * matched to the recipient from the receipt alone, so they stay reported. */
async function fastPaid(t, fast, ctx) {
  const chain = EVM_CHAIN[fast.chain];
  if (chain) {
    const leg = (await readTx(chain, fast.transaction_hash, ctx).catch(() => null))?.legs?.[0];
    return leg?.class === "PROVEN" && (leg.facts?.transfers ?? []).some((x) => x.to === bare(t.recipient));
  }
  return onChain(fast.chain, fast.transaction_hash, ctx);
}

async function transferToCase(t, ctx) {
  const id = t.transfer_id;
  const ref = `${id.chain}:${id.nonce ?? id.id ?? "?"}`;
  // A fast relayer pays the recipient before the bridge finishes; the bridge's own record repays the relayer later. The
  // recipient is paid either way, so nobody needs to finish anything for them.
  const fast = t.fast_finalised && t.fast_finalised.chain !== "Near" && t.fast_finalised.transaction_hash ? t.fast_finalised : null;
  const fastProven = fast ? await fastPaid(t, fast, ctx) : false;
  const paid = fast ? undefined : await paidOnContract(t, ctx);
  const contractRead = paid === true || paid === false;
  const status = fast || paid === true || isFinal(t.status) ? "FINALISED" : /signed/i.test(t.status) ? "SIGNED" : "INITIALISED";
  const confirmed = fast ? fastProven : status === "FINALISED" && !contractRead && (await onChain(t.destination_chain, destinationTx(t), ctx));
  const tx = t.initialised?.transaction_hash;
  const originProven = await onChain(t.initialised?.chain, tx, ctx);
  // An unpaid contract proves it hasn't been paid. It says nothing about the steps before that, so those need their own read.
  const signing = [t.signed].flat().filter(Boolean).at(-1);
  const stepsProven = originProven && (status !== "SIGNED" || (await onChain(signing?.chain ?? "Near", signing?.transaction_hash, ctx)));
  const agrees = confirmed || (contractRead && (status === "FINALISED" ? paid : !paid && stepsProven));
  const finish = status === "FINALISED" ? null : finishStep({ status: t.status, origin: t.origin_chain, dest: t.destination_chain });
  const evidence = tx ? [{ id: `omni:${tx}`, source: t.initialised.chain.toLowerCase(), kind: "tx", ref: tx, observedAt: iso(t.initialised.timestamp_seconds), class: originProven ? "PROVEN" : "REPORTED" }] : [];
  const dest = fast ? fast.transaction_hash : destinationTx(t);
  const destAt = (fast ?? t.finalised)?.timestamp_seconds;
  if (confirmed) evidence.push({ id: `omni:${dest}`, source: t.destination_chain.toLowerCase(), kind: "tx", ref: dest, class: "PROVEN", ...(destAt ? { observedAt: iso(destAt) } : { observedAt: ctx.now, undated: true }) });
  evidence.push({ id: `read:omni:${ref}`, source: "omni", kind: "read", ref, observedAt: ctx.now, class: agrees ? "PROVEN" : "REPORTED" });
  const legs = [{
    id: `omni:${ref}`, provider: "omni", ref, status, class: agrees ? "PROVEN" : "REPORTED", custody: status === "FINALISED" ? "recipient" : "omni bridge", evidence: tx ? [`omni:${tx}`] : [],
    ...(finish ? { finish } : {}),
    facts: { token: t.token_id, amount: t.amount, fee: t.fee, nativeFee: t.native_fee, from: t.origin_chain, to: t.destination_chain, originProven, ...(fast ? { fast: true } : {}) },
  }];
  if (paid === null) legs.push({ id: `contract:${ref}`, provider: `${t.destination_chain} bridge contract`, status: "LOOKUP_FAILED", class: "UNKNOWN", evidence: [] });
  return { legs, edges: [], evidence, claims: [], identifiers: [ref.toLowerCase(), tx].filter(Boolean), next: [] };
}

async function solanaCase(sig, ctx) {
  const tx = await solanaTransaction(sig, ctx);
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
      { id: `read:omni:${sig}`, source: "omni", kind: "read", ref: sig, observedAt: ctx.now, class: "REPORTED" },
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
