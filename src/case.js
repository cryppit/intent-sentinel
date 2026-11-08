// Opens a case from one pasted identifier: ask the sources, follow what they link to, and build the verdict.
import { table } from "./words.js";
import { readStatus } from "./adapters/oneclick.js";
import { readOrder } from "./adapters/near.js";
import { readTransfer } from "./adapters/omni.js";
import { readTx } from "./adapters/evm.js";
import { payoutSide } from "./adapters/payout-side.js";
import { readIdentifier } from "./incident.js";
import { buildVerdict } from "./verdict.js";
import { failedRead } from "./net.js";

const MAX_HOPS = 8;
const LIVE = { order: readOrder, transfer: readTransfer, evmTx: readTx, status: readStatus, payoutSide };
const EDGE = table({ CREDITED: "credited-to", PAID_OUT: "paid-to", REFUNDED: "refunded-to", CONTRACT_FORWARDED: "forwarded-to" });

function absorb(c, found, followUp = false) {
  for (const leg of found.legs) {
    const same = followUp && leg.ref && leg.status !== "LOOKUP_FAILED" && c.legs.find((l) => l.ref === leg.ref);
    if (!same) {
      c.legs.push(leg);
      continue;
    }
    same.facts = { ...same.facts, ...leg.facts };
    // A follow-up that can't prove the leg takes the proof away, whatever the first source said.
    if (leg.class !== "PROVEN") {
      same.class = leg.class;
      same.status = "NOT_PROVEN";
      for (const e of c.evidence) if (e.ref === leg.ref) e.class = leg.class;
    }
  }
  const seen = new Set(c.evidence.map((e) => e.id));
  c.evidence.push(...found.evidence.filter((e) => !seen.has(e.id)));
  c.claims.push(...found.claims);
  c.warnings.push(...(found.warnings ?? []));
  c.identifiers = [...new Set([...c.identifiers, ...found.identifiers])].sort();
}

// Hashes that may be a payout on another chain (the money arriving), which is the hash people most often hold.
const MAYBE_PAYOUT = new Set(["evm-tx", "hex-tx", "solana-tx"]);

async function firstAnswer(id, a, ctx, status) {
  if (id.kind === "omni-transfer") return a.transfer(id.value, ctx);
  // A payout is recognised first: it is quick to check, and the deposit search behind it is slow and can be rate-limited.
  if (MAYBE_PAYOUT.has(id.kind)) {
    const side = await a.payoutSide(id, ctx);
    if (side?.nearTx) {
      const traced = await a.order(side.nearTx, ctx);
      if (!traced.notFound) return traced;
    }
    if (side?.notice) return { notFound: side.notice, notice: true };
  }
  const order = await a.order(id.value, ctx);
  if (!order.notFound) return order;
  if (id.kind === "deposit-address") {
    if (status?.nearTx) return a.order(status.nearTx, ctx);
    return status?.failed ? failedRead("1click", id.value, "1Click could not be read", ctx.now) : order;
  }
  const omni = await a.transfer(id.value, ctx);
  return omni.notFound ? order : omni;
}

const linked = (legs) => legs.slice(1).map((l, i) => ({ from: legs[i].id, to: l.id, kind: EDGE[l.status] ?? "bridged-as" }));

export async function openCase(raw, ctx) {
  const id = readIdentifier(raw);
  if (id.error) return { error: id.error };
  const a = { ...LIVE, ...ctx.adapters };
  const status = id.kind === "deposit-address" ? await a.status(id.value, ctx) : null;
  const first = await firstAnswer(id, a, ctx, status);
  // A notice is a valid ID that can't be checked on its own (a payout, a busy account): plain words, not bad input.
  if (first.notFound) return { error: first.notFound, ...(first.notice ? { notice: true } : {}) };
  const caseData = { identifiers: [], legs: [], edges: [], evidence: [], claims: [], warnings: [] };
  absorb(caseData, first);
  const asked = new Set();
  const queue = [...first.next];
  while (queue.length && asked.size < MAX_HOPS) {
    const link = queue.shift();
    if (asked.has(link.value)) continue;
    asked.add(link.value);
    const found = await a.evmTx(link.chain, link.value, ctx, link.recipient);
    absorb(caseData, found, true);
    queue.push(...found.next);
  }
  if (status?.claim) caseData.claims.push(status.claim);
  if (!caseData.identifiers.length) caseData.identifiers = [id.value];
  caseData.edges = linked(caseData.legs);
  return { caseData, verdict: await buildVerdict(caseData) };
}

/** A recorded case: no network, so it works on stage and in a judge's sandbox. Node only. */
export async function replayCase(dir) {
  const { readFile } = await import("node:fs/promises");
  const caseData = JSON.parse(await readFile(`${dir}/case.json`, "utf8"));
  return { caseData, verdict: await buildVerdict(caseData) };
}
