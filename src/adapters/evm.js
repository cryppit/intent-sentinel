// An EVM payout: did the transaction succeed, what moved, and is the recipient a contract?
import { EVM_RPC } from "../../vendor/wms-core.mjs";
import { failedRead, postJson } from "../net.js";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FALLBACK = { eth: "https://ethereum-rpc.publicnode.com" };
const addr = (topic) => `0x${topic.slice(-40).toLowerCase()}`;

async function rpc(chain, method, params, ctx) {
  let last;
  for (const url of [EVM_RPC[chain], FALLBACK[chain]].filter(Boolean)) {
    try {
      const r = await postJson(url, { jsonrpc: "2.0", id: 1, method, params }, ctx);
      if (r.error) throw new Error(r.error.message);
      return r.result;
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error(`no RPC for ${chain}`);
}

function transfersIn(receipt) {
  return receipt.logs
    .filter((l) => l.topics?.[0] === TRANSFER && l.topics.length === 3)
    .map((l) => ({ token: l.address.toLowerCase(), from: addr(l.topics[1]), to: addr(l.topics[2]), amount: BigInt(l.data).toString() }));
}

/** `receiver` is the payout's known destination: used only when no token moved, e.g. native coins paid inside another call. */
export async function readTx(chain, hash, ctx, receiver) {
  try {
    const receipt = await rpc(chain, "eth_getTransactionReceipt", [hash], ctx);
    if (!receipt) return failedRead(chain, hash, "no node knows this transaction", ctx.now);
    const transfers = transfersIn(receipt);
    const recipient = transfers.at(-1)?.to ?? receiver?.toLowerCase() ?? receipt.to?.toLowerCase();
    const code = await rpc(chain, "eth_getCode", [recipient, "latest"], ctx);
    const ok = receipt.status === "0x1";
    return {
      legs: [{
        id: `evm:${hash}`, provider: chain, ref: hash, status: "PAID_OUT", class: ok ? "PROVEN" : "UNKNOWN", evidence: [`evm:${hash}`],
        facts: { recipient, recipientIsContract: code !== "0x" && code !== null, transfers, block: Number(receipt.blockNumber), ...(ok ? {} : { reverted: true }) },
      }],
      edges: [],
      evidence: [{ id: `evm:${hash}`, source: chain, kind: "read", ref: hash, observedAt: ctx.now, class: ok ? "PROVEN" : "UNKNOWN" }],
      claims: [],
      identifiers: [hash],
      next: [],
    };
  } catch (e) {
    return failedRead(chain, hash, e.message, ctx.now);
  }
}
