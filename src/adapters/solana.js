// Reading a Solana transaction. The browser-friendly endpoints go first: api.mainnet-beta refuses any request with a
// web origin, and some nodes drop old transactions, so one empty answer doesn't prove a transaction is missing.
import { postJsonOnce } from "../net.js";

export const SOLANA_RPCS = ["https://public.rpc.solanavibestation.com", "https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

/** The transaction, or null if every endpoint answered and none has it. Throws if one couldn't answer and none has it. */
export async function solanaTransaction(sig, ctx) {
  let failure = null;
  for (const url of SOLANA_RPCS) {
    try {
      const r = await postJsonOnce(url, { jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }] }, ctx);
      if (r.error) throw new Error(`${new URL(url).host}: ${r.error.message ?? "RPC error"}`);
      if (r.result) return r.result;
    } catch (e) {
      failure = e;
    }
  }
  if (failure) throw failure;
  return null;
}

/** A fetch for the tracer, which takes one Solana URL: it tries the others when the first refuses or has no answer. */
export const withSolanaFallback = (f) => async (url, init) => {
  if (url !== SOLANA_RPCS[0]) return f(url, init);
  let last = null;
  let failure = null;
  for (const rpc of SOLANA_RPCS) {
    try {
      const res = await f(rpc, init);
      last = res;
      if (res.ok) {
        const body = await res.clone().json();
        if (body.result && !body.error) return res;
      }
    } catch (e) {
      failure = e;
    }
  }
  if (last) return last;
  throw failure;
};
