// HOT bridge payouts, proven from public chain data with no key (written 8 Nov 2026).
// A HOT withdrawal burns the token on NEAR; HOT's own contract logs the burn with a unique nonce as its memo. On the EVM
// destination, HOT's contract pays out with withdraw(nonce, token, receiver, amount, signature) and marks the nonce used.
// So: usedNonces(nonce) == true means HOT's contract recorded this withdrawal as paid. If the transaction HOT names also
// succeeded and carries that withdraw call (often nested, e.g. inside an ERC-4337 EntryPoint call) for the same receiver,
// the payout is proven with its transaction. Anything less leaves the payout as the tracer left it: never a guess.
// On TON, a token payout (a "jetton", such as USDT) is proven from the transaction HOT names: it must be the receiver's
// own token wallet taking in exactly the burned amount from HOT's token wallet, finished and not failed (read on toncenter).
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
const TONCENTER = "https://toncenter.com/api/v3";
// HOT's TON wallet, which owns HOT's token wallets there (the "meta wallet").
const TON_HOT = "0:0D11588CDC0290CE2E808F7B047B2A85BBCA57AA1CBD43DC46A0877FD2AA7708";
const JETTON_IN = "0x178d4519";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const word = (n) => BigInt(n).toString(16).padStart(64, "0");

/** HOT's contract address on an EVM chain it pays out on, or null. */
export const hotContract = (chain) => (HOT_EVM.has(chain) ? EVM_CONTRACTS[chain] ?? DEFAULT_EVM : null);

/** Call data for usedNonces(uint128). */
export const usedNonceData = (nonce) => `${USED_NONCES}${word(nonce)}`;

/** HOT's own mt_burn in a NEAR transaction (FastNEAR's shape): its nonce (the memo), and the amount burned of `tokenId`
 * when one is given. Null if there is none. */
export function hotBurn(tx, tokenId) {
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
      for (const d of event.data ?? []) {
        if (!/^\d+$/.test(d.memo ?? "")) continue;
        if (tokenId === undefined) return { nonce: d.memo, amount: null };
        const i = (d.token_ids ?? []).indexOf(tokenId);
        if (i >= 0 && /^\d+$/.test(d.amounts?.[i] ?? "")) return { nonce: d.memo, amount: d.amounts[i] };
      }
    }
  }
  return null;
}

/** The nonce from HOT's own mt_burn log in a NEAR transaction (FastNEAR's shape), or null. */
export const hotNonce = (tx) => hotBurn(tx)?.nonce ?? null;

const rawTon = (wc, hash) => `${wc}:${hash.toString(16).toUpperCase().padStart(64, "0")}`;

/** HOT writes a TON token as `1117_` plus a base58 TON address: HOT's own wallet for that token. Raw form, or null. */
export function tonAddressOfHotId(id) {
  const m = /^(?:nep245:)?(?:v2_1\.omni\.hot\.tg:)?1117_([1-9A-HJ-NP-Za-km-z]+)$/.exec(id ?? "");
  if (!m) return null;
  let n = 0n;
  for (const c of m[1]) n = n * 58n + BigInt(B58.indexOf(c));
  // 272 bits: "100", an 8-bit workchain, the 256-bit address, then padding.
  if (n >> 269n !== 4n) return null;
  const wc = Number((n >> 261n) & 0xffn);
  return rawTon(wc > 127 ? wc - 256 : wc, (n >> 5n) & ((1n << 256n) - 1n));
}

/** A TON address in raw form ("0:ABC…"), from raw or from the short form wallets show (48 characters). Null if neither. */
export function tonRawAddress(text) {
  const s = String(text ?? "").trim();
  const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(s);
  if (raw) return `${raw[1]}:${raw[2].toUpperCase()}`;
  if (!/^[A-Za-z0-9_+/-]{48}$/.test(s)) return null;
  let bin;
  try {
    bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  if (bin.length !== 36) return null;
  const wc = bin.charCodeAt(1) > 127 ? bin.charCodeAt(1) - 256 : bin.charCodeAt(1);
  return `${wc}:${[...bin.slice(2, 34)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
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
  const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
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
  if (chain === "ton") return proveTonToken(w, payout, f);
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

const TON_WAIT_MS = 1100;

/** toncenter allows about one request a second without a key, so a refused or failed read is tried once more. */
async function getJson(f, url) {
  const once = async () => {
    const res = await f(url, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
    return res.json();
  };
  try {
    return await once();
  } catch {
    await new Promise((r) => setTimeout(r, TON_WAIT_MS));
    return once();
  }
}

/** A HOT payout of a TON token (jetton), proven from the transaction HOT names, or the payout as it was given. */
async function proveTonToken(w, payout, f) {
  const named = payout.bridgeReport?.tx;
  const bare = String(w.token ?? "").replace(/^nep245:/, "").replace(/^v2_1\.omni\.hot\.tg:/, "");
  const hotWallet = tonAddressOfHotId(bare);
  const receiver = tonRawAddress(payout.destination ?? w.destination);
  if (!named || !/^[0-9a-f]{64}$/i.test(named) || !hotWallet || !receiver || !w.tx) return payout;
  try {
    const near = await post(f, FASTNEAR_TX, { tx_hashes: [w.tx] });
    const burn = hotBurn(near.transactions?.[0], bare);
    if (!burn) return payout;
    const t = (await getJson(f, `${TONCENTER}/transactions?hash=${named}`)).transactions?.[0];
    const msg = t?.in_msg;
    const got = msg?.message_content?.decoded?.amount?.value;
    const done = t && t.finality === "finalized" && t.emulated !== true && t.description?.aborted === false && t.description?.compute_ph?.success === true;
    if (!done || msg.opcode !== JETTON_IN || tonRawAddress(msg.source) !== hotWallet || !/^\d+$/.test(got ?? "") || BigInt(got) !== BigInt(burn.amount)) return payout;
    const into = tonRawAddress(t.account);
    const wallets = (await getJson(f, `${TONCENTER}/jetton/wallets?address=${into}&address=${hotWallet}&limit=2`)).jetton_wallets ?? [];
    const theirs = wallets.find((x) => tonRawAddress(x.address) === into);
    const hots = wallets.find((x) => tonRawAddress(x.address) === hotWallet);
    if (!theirs || !hots || tonRawAddress(theirs.owner) !== receiver || tonRawAddress(hots.owner) !== TON_HOT || tonRawAddress(theirs.jetton) !== tonRawAddress(hots.jetton)) return payout;
    const burnSec = w.timestampNs != null ? Number(BigInt(w.timestampNs) / 1_000_000_000n) : null;
    return {
      ...payout, status: "arrived", how: "proven", tx: named, amount: burn.amount, confirmed: true, hotNonce: burn.nonce, from: TON_HOT,
      delaySec: burnSec !== null && Number.isFinite(t.now) ? t.now - burnSec : null,
    };
  } catch {
    return payout;
  }
}
