// HOT bridge payouts, proven from public chain data with no key (written 8 Nov 2026).
// A HOT withdrawal burns the token on NEAR; HOT's own contract logs the burn with a unique nonce as its memo. On the EVM
// destination, HOT's contract pays out with withdraw(nonce, token, receiver, amount, signature) and marks the nonce used.
// So: usedNonces(nonce) == true means HOT's contract recorded this withdrawal as paid. If the transaction HOT names also
// succeeded and carries that withdraw call (often nested, e.g. inside an ERC-4337 EntryPoint call) for the same receiver,
// the payout is proven with its transaction. Anything less leaves the payout as the tracer left it: never a guess.
import { EVM_RPC } from "../../vendor/wms-core.mjs";

const HOT_NEAR = "v2_1.omni.hot.tg";
const FASTNEAR_TX = "https://tx.main.fastnear.com/v0/transactions";
const DEFAULT_EVM = "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd";
const EVM_CONTRACTS = { adi: "0x4a3b9d07a9a1e3d9dfb0a6edfc87384f8f424003" };
const HOT_EVM = new Set(["bsc", "op", "pol", "avax", "scroll", "monad", "xlayer", "plasma", "adi"]);
const USED_NONCES = "0xfd82f7fd";
const WITHDRAW = "d9e7c316";
const ZERO = "0x0000000000000000000000000000000000000000";
const TIMEOUT_MS = 12_000;

const word = (n) => BigInt(n).toString(16).padStart(64, "0");

/** HOT's contract address on an EVM chain it pays out on, or null. */
export const hotContract = (chain) => (HOT_EVM.has(chain) ? EVM_CONTRACTS[chain] ?? DEFAULT_EVM : null);

/** Call data for usedNonces(uint128). */
export const usedNonceData = (nonce) => `${USED_NONCES}${word(nonce)}`;

/** The nonce from HOT's own mt_burn log in a NEAR transaction (FastNEAR's shape), or null. */
export function hotNonce(tx) {
  for (const r of tx?.receipts ?? []) {
    const outcome = r.execution_outcome?.outcome;
    if (outcome?.executor_id !== HOT_NEAR) continue;
    for (const log of outcome.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let event;
      try {
        event = JSON.parse(log.slice("EVENT_JSON:".length));
      } catch {
        continue;
      }
      if (event.standard !== "nep245" || event.event !== "mt_burn") continue;
      const memo = event.data?.find((d) => /^\d+$/.test(d.memo ?? ""))?.memo;
      if (memo) return memo;
    }
  }
  return null;
}

/** HOT's withdraw call for this nonce anywhere in a transaction's input, decoded, or null. */
export function nestedWithdraw(input, nonce) {
  const at = String(input ?? "").toLowerCase().indexOf(`${WITHDRAW}${word(nonce)}`);
  if (at < 0) return null;
  const w = (k) => input.slice(at + 8 + 64 * k, at + 8 + 64 * (k + 1));
  if (w(3).length !== 64) return null;
  return { token: `0x${w(1).slice(-40)}`.toLowerCase(), receiver: `0x${w(2).slice(-40)}`.toLowerCase(), amount: BigInt(`0x${w(3)}`) };
}

async function post(f, url, body) {
  const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json();
}

async function rpc(f, url, method, params) {
  const j = await post(f, url, { jsonrpc: "2.0", id: 1, method, params });
  if (j.error) throw new Error(`${new URL(url).host}: ${j.error.message ?? "JSON-RPC error"}`);
  return j.result;
}

/**
 * Tries to prove an unproven HOT payout. Returns a new payout record ("proven" with the transaction, or "recorded" from
 * the contract alone) or the one it was given. A failed read never turns into "paid".
 */
export async function proveHotPayout(w, payout, { fetch: f = fetch } = {}) {
  if (w?.bridge !== "hot" || payout?.status === "arrived") return payout;
  const chain = payout.chain ?? w.chain;
  const contract = hotContract(chain);
  const url = EVM_RPC[chain];
  if (!contract || !url || !w.tx) return payout;
  try {
    const near = await post(f, FASTNEAR_TX, { tx_hashes: [w.tx] });
    const nonce = hotNonce(near.transactions?.[0]);
    if (!nonce) return payout;
    const used = await rpc(f, url, "eth_call", [{ to: contract, data: usedNonceData(nonce) }, "latest"]);
    if (!/^0x0*1$/.test(String(used))) return payout;
    const recorded = { ...payout, status: "arrived", how: "recorded", tx: null, amount: null, confirmed: true, hotNonce: nonce };
    const named = payout.bridgeReport?.tx;
    if (!named) return recorded;
    const [sent, receipt] = await Promise.all([rpc(f, url, "eth_getTransactionByHash", [named]), rpc(f, url, "eth_getTransactionReceipt", [named])]);
    const call = nestedWithdraw(sent?.input, nonce);
    const receiver = String(payout.destination ?? w.destination ?? "").toLowerCase();
    if (receipt?.status !== "0x1" || !call || call.receiver !== receiver) return recorded;
    return { ...recorded, how: "proven", tx: named, amount: call.amount.toString(), from: contract, native: call.token === ZERO };
  } catch {
    return payout;
  }
}
