// What a pasted identifier is, and the incident key a set of them gives. Base58 keeps its case; hex does not have one.
import { sha256Hex } from "./canon.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const OMNI_CHAINS = ["near", "eth", "sol", "arb", "base", "bnb", "btc", "zcash", "pol", "hlevm", "strk", "abs", "fogo", "aptos", "avax"];
const HELP = "We don't recognise that. Paste a transaction ID (hash), a block explorer link, or the deposit address your swap app gave you.";

/** The last path segment of an explorer link, or the text unchanged. */
function unwrapLink(text) {
  if (!/^https?:\/\//i.test(text)) return text;
  try {
    const parts = new URL(text).pathname.split("/").filter(Boolean);
    return parts.at(-1) ?? text;
  } catch {
    return text;
  }
}

export function readIdentifier(raw) {
  const text = unwrapLink(String(raw ?? "").trim());
  if (!text) return { error: "Paste a transaction ID, a block explorer link or a deposit address." };
  if (/^0x[0-9a-f]{64}$/i.test(text)) return { kind: "evm-tx", value: text.toLowerCase() };
  if (/^0x[0-9a-f]{40}$/i.test(text)) return { kind: "deposit-address", value: text.toLowerCase() };
  if (/^[0-9a-f]{64}$/i.test(text)) return { kind: "hex-tx", value: text.toLowerCase() };
  const omni = /^([a-z]+):(\d+)$/i.exec(text);
  if (omni && OMNI_CHAINS.includes(omni[1].toLowerCase())) return { kind: "omni-transfer", value: `${omni[1].toLowerCase()}:${omni[2]}` };
  if (/\.testnet$/i.test(text)) return { error: "That's a test-network account (it ends in .testnet). Intent Sentinel only checks real swaps, because NEAR Intents has no test network." };
  if (/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.near$/.test(text)) return { kind: "deposit-address", value: text };
  if (/^(bc1[a-z0-9]{25,87}|T[1-9A-HJ-NP-Za-km-z]{33})$/.test(text)) return { kind: "deposit-address", value: text };
  if (BASE58.test(text) && text.length >= 43 && text.length <= 44) return { kind: "near-tx", value: text };
  if (BASE58.test(text) && text.length >= 86 && text.length <= 88) return { kind: "solana-tx", value: text };
  return { error: HELP };
}

/** `iv1_<sha256>` of the sorted, de-duplicated identifier set: any route into a case gives the same incident. */
export async function incidentId(ids) {
  const set = [...new Set(ids)].sort();
  return `iv1_${await sha256Hex(set.join("\n"))}`;
}
