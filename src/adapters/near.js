// A NEAR Intents order, read through the Where's My Swap tracer (declared baseline) and turned into legs.
// Conservation is claimed only on the NEAR ledger, and only with no swap: bridges take fees they don't report, and a swap
// changes the token, so anything else would be a guess.
import { checkOrderWithFallback, fastnearClient, fastnearUnavailable, publicOriginClient, publicPayoutClient } from "../../vendor/wms-core.mjs";
import { failedRead } from "../net.js";

const iso = (ns) => (ns == null ? null : new Date(Number(BigInt(ns) / 1_000_000n)).toISOString());
const short = (chain) => String(chain ?? "unknown").split(":")[0];
const PROVEN_PAYOUT = ["proven", "confirmed", "recorded"];

function evidenceOf(report, now) {
  const near = [...report.deposits, ...report.swaps, ...report.transfers, ...report.withdrawals];
  const items = near.filter((h) => h.tx).map((h) => ({ id: `near:${h.tx}`, source: "near", kind: "tx", ref: h.tx, observedAt: iso(h.timestampNs) ?? now, class: "PROVEN" }));
  if (report.origin.txHash) items.push({ id: `origin:${report.origin.txHash}`, source: short(report.origin.chain), kind: "tx", ref: report.origin.txHash, observedAt: now, class: "PROVEN" });
  if (report.payout.tx) {
    const cls = PROVEN_PAYOUT.includes(report.payout.how) ? "PROVEN" : "INFERRED";
    items.push({ id: `payout:${report.payout.tx}`, source: short(report.payout.chain), kind: "tx", ref: report.payout.tx, observedAt: now, class: cls });
  }
  items.push({ id: `read:near:${report.account}`, source: "near", kind: "read", ref: report.account, observedAt: now, class: "PROVEN" });
  return items;
}

function ledgerBalance(report) {
  if (report.swaps.length || report.transfers.length) return {};
  const tokens = new Set([...report.deposits, ...report.withdrawals].map((h) => h.token));
  if (tokens.size !== 1 || !report.withdrawals.length) return {};
  const token = [...tokens][0];
  const held = report.balances[token];
  return {
    amountIn: report.deposits.reduce((sum, d) => sum + BigInt(d.amount), 0n).toString(),
    amountOut: [...report.withdrawals.map((w) => w.amount), ...(held && held !== "0" ? [held] : [])],
  };
}

function endLeg(report, lastAt) {
  const p = report.payout;
  const paid = { provider: short(p.chain), ref: p.tx ?? undefined, amount: p.amount ?? undefined, class: PROVEN_PAYOUT.includes(p.how) ? "PROVEN" : "INFERRED", at: lastAt };
  switch (report.verdict) {
    case "settled": return { ...paid, id: "payout", status: "PAID_OUT", custody: "recipient" };
    case "refunded": return { ...paid, id: "refund", status: "REFUNDED", custody: "refund address" };
    case "confidential": return { id: "private", provider: "near-intents", status: "NOT_VISIBLE", class: "NOT_VISIBLE", custody: "not visible" };
    case "stuck": return { id: "held", provider: "near-intents", status: "HELD", class: "PROVEN", custody: "intents.near", window: { dueBy: lastAt } };
    case "in_progress": return { id: "held", provider: "near-intents", status: "HELD", class: "PROVEN", custody: "intents.near" };
    default: return null;
  }
}

export function traceToLegs(report, now) {
  const legs = [];
  const o = report.origin;
  if (report.verdict === "not_found") legs.push({ id: "origin", provider: "near-intents", ref: report.account, status: "DEPOSIT_NOT_FOUND", class: "PROVEN" });
  else if (o.status === "proven") legs.push({ id: "origin", provider: short(o.chain), ref: o.txHash ?? o.originNonce, status: "DEPOSIT_CONFIRMED", class: "PROVEN", custody: "bridge" });
  else if (o.status === "unverified") legs.push({ id: "origin", provider: "unknown", status: "DEPOSIT_CONFIRMED", class: "INFERRED", custody: "bridge" });
  const times = [...report.deposits, ...report.withdrawals].map((h) => iso(h.timestampNs)).filter(Boolean).sort();
  const lastAt = times.at(-1) ?? now;
  if (report.deposits.length) {
    legs.push({ id: "credit", provider: "near-intents", ref: report.deposits[0].tx, status: "CREDITED", class: "PROVEN", custody: "intents.near", evidence: report.deposits.map((d) => `near:${d.tx}`), ...ledgerBalance(report) });
  }
  const end = endLeg(report, lastAt);
  if (end) legs.push(end);
  const followed = report.payout.status === "arrived" && PROVEN_PAYOUT.includes(report.payout.how) && report.payout.tx?.startsWith("0x");
  const ids = [report.account, o.txHash, o.originNonce, ...[...report.deposits, ...report.swaps, ...report.transfers, ...report.withdrawals].map((h) => h.tx), report.payout.tx];
  return {
    legs: legs.map((l) => ({ evidence: [], ...l })),
    edges: [],
    evidence: evidenceOf(report, now),
    claims: [],
    identifiers: [...new Set(ids.filter(Boolean))],
    next: followed ? [{ kind: "evm-tx", chain: report.payout.chain, value: report.payout.tx }] : [],
  };
}

const liveCheck = (raw, ctx) => {
  const f = ctx.fetch ?? fetch;
  return checkOrderWithFallback(raw, fastnearClient(f), BigInt(Date.parse(ctx.now)) * 1_000_000n, undefined, publicPayoutClient(f), publicOriginClient(f));
};

export async function readOrder(raw, ctx) {
  try {
    return traceToLegs(await (ctx.check ?? liveCheck)(raw, ctx), ctx.now);
  } catch (e) {
    if (fastnearUnavailable(e)) return failedRead("near", raw, e.message, ctx.now);
    return { notFound: e.message };
  }
}
