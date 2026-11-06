// A 1Click status, as a claim. The terms allow keeping 1Click data for 24 hours at most, so nothing here is stored: only
// the category word and the time we saw it are kept. The NEAR hash is used in memory to find the order on chain, and
// what the case then holds came from the chain.
import { getJson } from "../net.js";

const STATUS = "https://1click.chaindefuser.com/v0/status";
const CATEGORY = {
  SUCCESS: "SUCCESS", FAILED: "FAILED", REFUNDED: "REFUNDED",
  PENDING_DEPOSIT: "PENDING", KNOWN_DEPOSIT_TX: "PENDING", INCOMPLETE_DEPOSIT: "PENDING", PROCESSING: "PENDING",
};

export async function readStatus(depositAddress, ctx) {
  try {
    const r = await getJson(`${STATUS}?depositAddress=${encodeURIComponent(depositAddress)}`, ctx);
    const claim = { by: "1click", status: CATEGORY[r.status] ?? "UNKNOWN", observedAt: ctx.now, class: "REPORTED" };
    return { claim, nearTx: r.swapDetails?.nearTxHashes?.[0] ?? null };
  } catch (e) {
    return /answered 404/.test(e.message) ? null : { claim: null, nearTx: null, failed: true };
  }
}

export const readClaim = async (depositAddress, ctx) => (await readStatus(depositAddress, ctx))?.claim ?? null;
