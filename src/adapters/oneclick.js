// A 1Click status, as a claim. The terms allow keeping 1Click data for 24 hours at most, so nothing here is stored: only
// the category word and the time we saw it leave this function, and the answer itself goes out of scope.
import { getJson } from "../net.js";

const STATUS = "https://1click.chaindefuser.com/v0/status";
const CATEGORY = {
  SUCCESS: "SUCCESS", FAILED: "FAILED", REFUNDED: "REFUNDED",
  PENDING_DEPOSIT: "PENDING", KNOWN_DEPOSIT_TX: "PENDING", INCOMPLETE_DEPOSIT: "PENDING", PROCESSING: "PENDING",
};

export async function readClaim(depositAddress, ctx) {
  try {
    const r = await getJson(`${STATUS}?depositAddress=${encodeURIComponent(depositAddress)}`, ctx);
    return { by: "1click", status: CATEGORY[r.status] ?? "UNKNOWN", observedAt: ctx.now, class: "REPORTED" };
  } catch {
    return null;
  }
}
