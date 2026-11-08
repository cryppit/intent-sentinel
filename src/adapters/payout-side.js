// A pasted transaction that isn't a deposit may be the payout: the money arriving on the receiving chain, which is the
// hash a user is most likely to hold. HOT's indexer can be asked by payout hash, so a HOT payout leads back to its NEAR
// transaction and the case is then read from the chain as usual. For other bridges no public record leads back, so the
// payout is only recognised by who sent it (the bridge's public payout wallets), and the user is told what to paste.
import { EVM_RPC } from "../../vendor/wms-core.mjs";
import { hotContract } from "./hot.js";
import { SOLANA_RPCS } from "./solana.js";
import { placeName } from "../words.js";

const HOT_INDEXER = "https://bridge-indexer.chaindefuser.com/api/v1/withdrawals";
const MEMPOOL = "https://mempool.space/api";
const TRONGRID = "https://api.trongrid.io";
const TIMEOUT_MS = 12_000;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const NEAR_INTENTS = "NEAR Intents";
const HOT = "the HOT bridge";
// The bridges' public payout wallets (the same lists the tracer uses to name a payout's sender).
const EVM_SENDERS = { "0x2cff890f0378a11913b6129b2e97417a2c302680": NEAR_INTENTS, "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd": HOT, "0x4a3b9d07a9a1e3d9dfb0a6edfc87384f8f424003": HOT };
const BTC_SENDERS = { "1C6XJtNXiuXvk4oUAVMkKF57CRpaTrN5Ra": NEAR_INTENTS };
const TRON_SENDERS = { "41e78cc21a0dfb6e840d52652224493b60d02ed628": NEAR_INTENTS };
const SOL_SENDERS = { HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16: NEAR_INTENTS, "8sXzdKW2jFj7V5heRwPMcygzNH3JZnmie5ZRuNoTuKQC": HOT };
const EVM_CHAINS = Object.keys(EVM_RPC).filter((c) => c !== "hypercore");

export const payoutWords = (by, chain) =>
  `That's the payout transaction (money arriving). ${by} sent it on ${placeName(chain)}. To check your swap, paste the transaction that sent the money, or the deposit address.`;

/** JSON from a source, or null when it doesn't answer, has nothing, or isn't reachable: this check never throws. */
async function read(f, url, body) {
  try {
    const init = body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { headers: { accept: "application/json" } };
    const res = await f(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
const rpc = async (f, url, method, params) => (await read(f, url, { jsonrpc: "2.0", id: 1, method, params }))?.result ?? null;

async function hotRecord(f, hash) {
  const r = await read(f, `${HOT_INDEXER}?hash=${encodeURIComponent(hash)}`);
  const w = (r?.withdrawals ?? []).find((x) => x?.bridge === "HOT" && String(x.hash ?? "").toLowerCase() === hash.toLowerCase());
  return w && typeof r.near_trx === "string" ? { nearTx: r.near_trx, chain: w.blockchain ?? null, by: HOT } : null;
}

async function evmSender(f, hash) {
  const found = await Promise.all(EVM_CHAINS.map(async (chain) => ({ chain, tx: await rpc(f, EVM_RPC[chain], "eth_getTransactionByHash", [hash]) })));
  const hit = found.find((x) => x.tx?.blockNumber);
  if (!hit) return null;
  const { chain, tx } = hit;
  const direct = EVM_SENDERS[String(tx.from ?? "").toLowerCase()];
  if (direct) return { chain, by: direct };
  const receipt = await rpc(f, EVM_RPC[chain], "eth_getTransactionReceipt", [hash]);
  const hot = hotContract(chain);
  for (const log of receipt?.logs ?? []) {
    if (hot && String(log.address ?? "").toLowerCase() === hot) return { chain, by: HOT };
    if (log.topics?.[0] === TRANSFER && log.topics.length === 3) {
      const by = EVM_SENDERS[`0x${String(log.topics[1]).slice(-40).toLowerCase()}`];
      if (by) return { chain, by };
    }
  }
  return null;
}

async function btcSender(f, hash) {
  const tx = await read(f, `${MEMPOOL}/tx/${hash}`);
  const by = (tx?.vin ?? []).map((v) => BTC_SENDERS[v?.prevout?.scriptpubkey_address]).find(Boolean);
  return by ? { chain: "btc", by } : null;
}

async function tronSender(f, hash) {
  const tx = await read(f, `${TRONGRID}/wallet/gettransactionbyid`, { value: hash });
  const by = TRON_SENDERS[String(tx?.raw_data?.contract?.[0]?.parameter?.value?.owner_address ?? "").toLowerCase()];
  return by ? { chain: "tron", by } : null;
}

async function solanaSender(f, sig) {
  for (const url of SOLANA_RPCS) {
    const tx = await rpc(f, url, "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
    if (!tx) continue;
    const by = SOL_SENDERS[tx.transaction?.message?.accountKeys?.[0]];
    return by ? { chain: "sol", by } : null;
  }
  return null;
}

const SENDERS = { "evm-tx": [evmSender], "hex-tx": [btcSender, tronSender], "solana-tx": [solanaSender] };

/**
 * For a pasted transaction hash that no deposit names: { nearTx } when HOT's records lead back to the NEAR transaction,
 * { notice } when a bridge's payout wallet sent it, or null when it doesn't look like a payout.
 */
export async function payoutSide(id, ctx) {
  const readers = SENDERS[id.kind];
  if (!readers) return null;
  const f = ctx.fetch ?? fetch;
  const back = await hotRecord(f, id.value);
  if (back) return back;
  for (const reader of readers) {
    const sent = await reader(f, id.value);
    if (sent) return { notice: payoutWords(sent.by[0].toUpperCase() + sent.by.slice(1), sent.chain) };
  }
  return null;
}
