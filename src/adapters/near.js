// A NEAR Intents order, read through the Where's My Swap tracer (declared baseline) and turned into legs.
// Conservation is claimed only on the NEAR ledger, and only with no swap: bridges take fees they don't report, and a swap
// changes the token. Where it can't be checked, the case says so rather than staying silent.
import { checkOrderWithFallback, EVM_RPC, fastnearClient, fastnearUnavailable, payingWithdrawal, publicOriginClient, publicPayoutClient, searchPayout } from "../../vendor/wms-core.mjs";
import { failedRead } from "../net.js";
import { proveHotPayout } from "./hot.js";
import { SOLANA_RPCS, withSolanaFallback } from "./solana.js";

const iso = (ns) => (ns == null ? null : new Date(Number(BigInt(ns) / 1_000_000n)).toISOString());
// The tracer writes chains several ways: eth:8453 is Base, bnb is bsc, zcash:mainnet is zec. An EVM id we don't know keeps
// its id, so it's never called Ethereum.
const EVM_IDS = { 1: "eth", 8453: "base", 42161: "arb", 100: "gnosis", 9745: "plasma", 80094: "bera", 56: "bsc", 10: "op", 137: "pol", 43114: "avax", 196: "xlayer", 4663: "hood" };
const CHAIN_ALIAS = { bnb: "bsc", zcash: "zec", strk: "starknet" };
const short = (chain) => {
  const [network, id] = String(chain ?? "near").toLowerCase().split(":");
  if (network === "eth" && id) return EVM_IDS[id] ?? `eth:${id}`;
  return CHAIN_ALIAS[network] ?? network;
};
const PROVEN_PAYOUT = ["proven", "confirmed", "recorded"];
const SOURCE_TIMEOUT_MS = 12_000;
const CASE_TIMEOUT_MS = 45_000;
// Tracer flags that mean the order isn't simply finished, and who can answer each.
const WARNINGS = {
  destination_missing: "user", locked: "near-intents", withdrawal_refused: "near-intents", withdrawal_returned: "near-intents", payout_bounced: "near-intents",
  ledger_mismatch: "unknown", incomplete_history: "unknown", several_orders: "unknown", executing: "unknown",
};

const classOf = (payout) => (PROVEN_PAYOUT.includes(payout.how) ? "PROVEN" : "INFERRED");
const later = (ns, sec) => new Date(Number(BigInt(ns) / 1_000_000n) + (sec ?? 0) * 1000).toISOString();

/** Each withdrawal with its payout. The tracer searches only the paying one; `otherPayouts` holds the rest. */
function endsOf(report) {
  const paying = payingWithdrawal(report);
  const live = report.withdrawals.filter((w) => w === paying || !(w.returned || w.refused || w.bounced));
  if (!live.length) return report.verdict === "settled" || report.verdict === "refunded" ? [{ w: null, payout: report.payout }] : [];
  return live.map((w) => ({ w, payout: w === paying ? report.payout : report.otherPayouts?.[w.tx] ?? { status: "missing" } }));
}

function evidenceOf(report, ends, now) {
  const near = [...report.deposits, ...report.swaps, ...report.transfers, ...report.withdrawals];
  const items = near.filter((h) => h.tx).map((h) => ({ id: `near:${h.tx}`, source: "near", kind: "tx", ref: h.tx, observedAt: iso(h.timestampNs) ?? now, class: "PROVEN" }));
  // The tracer doesn't give the origin chain's time, so the deposit is dated by its credit: it can't be later than that.
  const firstCredit = report.deposits[0]?.timestampNs;
  if (report.origin.txHash) items.push({ id: `origin:${report.origin.txHash}`, source: short(report.origin.chain), kind: "tx", ref: report.origin.txHash, observedAt: iso(firstCredit) ?? now, class: "PROVEN" });
  for (const { w, payout } of ends) {
    if (!payout.tx) continue;
    const at = w?.timestampNs != null ? later(w.timestampNs, payout.delaySec) : now;
    items.push({ id: `payout:${payout.tx}`, source: short(payout.chain), kind: "tx", ref: payout.tx, observedAt: at, class: classOf(payout) });
  }
  for (const item of items) if (item.observedAt === now) item.undated = true;
  items.push({ id: `read:near:${report.account}`, source: "near", kind: "read", ref: report.account, observedAt: now, class: "PROVEN" });
  return items;
}

function ledgerBalance(report) {
  if (report.swaps.length || report.transfers.length) return { unchecked: "a swap or transfer changes what the amounts mean" };
  const tokens = new Set([...report.deposits, ...report.withdrawals].map((h) => h.token));
  if (!report.withdrawals.length) return {};
  if (tokens.size !== 1) return { unchecked: "more than one token" };
  const token = [...tokens][0];
  const held = report.balances[token];
  return {
    amountIn: report.deposits.reduce((sum, d) => sum + BigInt(d.amount), 0n).toString(),
    amountOut: [...report.withdrawals.map((w) => w.amount), ...(held && held !== "0" ? [held] : [])],
  };
}

function endLeg({ w, payout }, report, at) {
  // The tracer's "refunded" means the deposited token left without a swap. It's only a refund if it went back where it came from.
  const backHome = report.origin?.status === "proven" && payout.chain && short(report.origin.chain) === short(payout.chain);
  const isRefund = w?.excessRefund || (report.verdict === "refunded" && backHome);
  const id = `end:${w?.tx ?? "order"}`;
  if (payout.status !== "arrived") return { id, provider: short(payout.chain ?? w?.chain ?? "unknown"), ref: w?.tx, status: "PAYOUT_UNSEEN", class: "UNKNOWN", custody: "unknown", at };
  return { id, provider: short(payout.chain), ref: payout.tx ?? w?.tx, amount: payout.amount ?? undefined, class: classOf(payout), at, status: isRefund ? "REFUNDED" : "PAID_OUT", custody: isRefund ? "refund address" : "recipient" };
}

function openLeg(report, lastAt) {
  if (report.verdict === "confidential") return { id: "private", provider: "near-intents", status: "NOT_VISIBLE", class: "NOT_VISIBLE", custody: "not visible" };
  if (report.verdict === "stuck") return { id: "held", provider: "near-intents", status: "HELD", class: "PROVEN", custody: "intents.near", window: { dueBy: lastAt } };
  if (report.verdict === "in_progress") return { id: "held", provider: "near-intents", status: "HELD", class: "PROVEN", custody: "intents.near" };
  return null;
}

export function traceToLegs(report, now) {
  const legs = [];
  const o = report.origin;
  if (o.status === "proven") legs.push({ id: "origin", provider: short(o.chain), ref: o.txHash ?? o.originNonce, status: "DEPOSIT_CONFIRMED", class: "PROVEN", custody: "bridge" });
  else if (o.status === "unverified") legs.push({ id: "origin", provider: "unknown", status: "DEPOSIT_CONFIRMED", class: "INFERRED", custody: "bridge" });
  const times = [...report.deposits, ...report.withdrawals].map((h) => iso(h.timestampNs)).filter(Boolean).sort();
  const lastAt = times.at(-1) ?? now;
  if (report.deposits.length) {
    legs.push({ id: "credit", provider: "near-intents", ref: report.deposits[0].tx, status: "CREDITED", class: "PROVEN", custody: "intents.near", evidence: report.deposits.map((d) => `near:${d.tx}`), ...ledgerBalance(report) });
  }
  const ends = report.verdict === "confidential" ? [] : endsOf(report);
  legs.push(...ends.map((e) => endLeg(e, report, lastAt)));
  const open = openLeg(report, lastAt);
  if (open) legs.push(open);
  if (report.balanceCheck?.status === "not_verified") legs.push({ id: "balance-check", provider: "intents.near", status: "LOOKUP_FAILED", class: "UNKNOWN", reason: report.balanceCheck.reason });
  const follow = ends.filter(({ payout }) => payout.status === "arrived" && PROVEN_PAYOUT.includes(payout.how) && payout.tx?.startsWith("0x") && EVM_RPC[short(payout.chain)]);
  const hops = [...report.deposits, ...report.swaps, ...report.transfers, ...report.withdrawals].map((h) => h.tx);
  const ids = [report.account, o.txHash, o.originNonce, ...hops, ...ends.map((e) => e.payout.tx)];
  return {
    legs: legs.map((l) => ({ evidence: [], ...l })),
    edges: [],
    evidence: evidenceOf(report, ends, now),
    claims: [],
    identifiers: [...new Set(ids.filter(Boolean))],
    warnings: report.flags.filter((f) => f.kind in WARNINGS).map(({ kind, detail }) => ({ kind, party: WARNINGS[kind], detail })),
    next: follow.map(({ payout }) => ({ kind: "evm-tx", chain: short(payout.chain), value: payout.tx, ...(payout.destination ? { recipient: payout.destination } : {}) })),
  };
}

const timed = (f) => (url, init = {}) => f(url, { ...init, signal: init.signal ?? AbortSignal.timeout(SOURCE_TIMEOUT_MS) });

async function liveCheck(raw, ctx) {
  const f = timed(ctx.fetch ?? fetch);
  const nowNs = BigInt(Date.parse(ctx.now)) * 1_000_000n;
  const payouts = publicPayoutClient(withSolanaFallback(f), { solanaRpc: SOLANA_RPCS[0] });
  const report = await checkOrderWithFallback(raw, fastnearClient(f), nowNs, undefined, payouts, publicOriginClient(f));
  const paying = payingWithdrawal(report);
  const others = report.withdrawals.filter((w) => w !== paying && !(w.returned || w.refused || w.bounced));
  const found = await Promise.all(others.map((w) => searchPayout(w, payouts, nowNs).catch(() => ({ status: "unverified" }))));
  return withHotProof({ ...report, otherPayouts: Object.fromEntries(others.map((w, i) => [w.tx, found[i]])) }, { fetch: f });
}

/** HOT payouts the tracer couldn't see (native coins, or a withdraw call nested in another call), proven from chain data. */
export async function withHotProof(report, opts = {}) {
  const paying = payingWithdrawal(report);
  const payout = paying && report.payout ? await proveHotPayout(paying, report.payout, opts) : report.payout;
  const others = { ...(report.otherPayouts ?? {}) };
  for (const w of report.withdrawals) if (others[w.tx]) others[w.tx] = await proveHotPayout(w, others[w.tx], opts);
  return { ...report, payout, otherPayouts: others };
}

/** A broken source, not an answer about the order: these must never read as "no such order". */
const sourceFailed = (e) => fastnearUnavailable(e) || ["TimeoutError", "AbortError", "SyntaxError", "TypeError"].includes(e.name) || /\bHTTP \d{3}\b|answered \d{3}/.test(e.message);

// The tracer follows a pasted transaction to the account that signed it. When that account settles many orders, such as
// a solver or the private settlement account, the transaction doesn't belong to one swap.
const BUSY = /^(\S+) has .* transactions: that is a wallet account/;
const looksLikeTx = (raw) => /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(String(raw).trim());
function plainNotFound(raw, message) {
  const busy = BUSY.exec(message);
  if (!busy || !looksLikeTx(raw)) return message;
  return `That transaction was signed by ${busy[1]}, which settles many orders, so it doesn't belong to one swap. Paste your own deposit transaction or deposit address instead.`;
}

export async function readOrder(raw, ctx) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("the source took too long"), { name: "TimeoutError" })), ctx.timeoutMs ?? CASE_TIMEOUT_MS);
  });
  try {
    const report = await Promise.race([(ctx.check ?? liveCheck)(raw, ctx), limit]);
    if (report.verdict === "not_found") return { notFound: "No NEAR Intents order was found for that id." };
    return traceToLegs(report, ctx.now);
  } catch (e) {
    return sourceFailed(e) ? failedRead("near", raw, e.message, ctx.now) : { notFound: plainNotFound(raw, e.message) };
  } finally {
    clearTimeout(timer);
  }
}
