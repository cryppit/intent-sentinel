// Reading a Solana transaction. The browser-friendly endpoints go first: api.mainnet-beta refuses any request with a
// web origin, and some nodes drop old transactions, so one empty answer doesn't prove a transaction is missing.
import { postJson } from "../net.js";

export const SOLANA_RPCS = ["https://public.rpc.solanavibestation.com", "https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

/** The transaction, or null if every endpoint answered and none has it. Throws if one couldn't answer and none has it. */
export async function solanaTransaction(sig, ctx) {
  let failure = null;
  for (const url of SOLANA_RPCS) {
    try {
      const r = await postJson(url, { jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }] }, ctx);
      if (r.result) return r.result;
    } catch (e) {
      failure = e;
    }
  }
  if (failure) throw failure;
  return null;
}
