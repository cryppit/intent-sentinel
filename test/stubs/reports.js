// Hand-written reports in the shape of the Where's My Swap tracer's OrderReport. Made-up values, no real order.
const base = {
  account: "order.example",
  origin: { status: "proven", kind: "poa", chain: "eth:1", txHash: "0xorigin", how: "test" },
  deposits: [{ status: "proven", tx: "NEARCREDIT", timestampNs: 1790000000000000000n, height: 10, token: "nep141:usdc", amount: "100" }],
  swaps: [],
  transfers: [],
  withdrawals: [{ status: "proven", tx: "NEARWITHDRAW", timestampNs: 1790000100000000000n, height: 20, kind: "ft_withdraw", token: "nep141:usdc", amount: "100", chain: "eth", bridge: "poa", destination: "0xdest" }],
  balances: {},
  flags: [],
  resolvedVia: "transaction",
};
const arrived = (how) => ({ status: "arrived", how, chain: "eth", destination: "0xdest", tx: "0xpayout", amount: "99", delaySec: 5 });
export const paidReport = { ...base, verdict: "settled", payout: arrived("proven") };
export const matchedReport = { ...base, verdict: "settled", payout: arrived("matched") };
export const refundedReport = { ...base, verdict: "refunded", payout: arrived("confirmed") };
export const privateReport = { ...base, verdict: "confidential", withdrawals: [], payout: { status: "missing" } };
export const stuckReport = { ...base, verdict: "stuck", withdrawals: [], balances: { "nep141:usdc": "100" }, payout: { status: "missing" } };
export const notFoundReport = { ...base, verdict: "not_found", origin: { status: "missing" }, deposits: [], withdrawals: [], payout: { status: "missing" } };
export const swappedReport = { ...paidReport, swaps: [{ status: "proven", tx: "NEARSWAP", timestampNs: 1790000050000000000n, height: 15 }] };
