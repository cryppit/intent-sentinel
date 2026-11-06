// Opens a case from one pasted identifier: ask the sources, follow what they link to, and build the verdict.
import { readClaim } from "./adapters/oneclick.js";
import { readOrder } from "./adapters/near.js";
import { readTransfer } from "./adapters/omni.js";
import { readTx } from "./adapters/evm.js";
import { readIdentifier } from "./incident.js";
import { buildVerdict } from "./verdict.js";

const MAX_HOPS = 8;
const LIVE = { order: readOrder, transfer: readTransfer, evmTx: readTx, claim: readClaim };
const EDGE = { CREDITED: "credited-to", PAID_OUT: "paid-to", REFUNDED: "refunded-to", CONTRACT_FORWARDED: "forwarded-to" };

function absorb(c, found) {
  for (const leg of found.legs) {
    const same = leg.ref && leg.status !== "LOOKUP_FAILED" && c.legs.find((l) => l.ref === leg.ref && l.status === leg.status);
    if (!same) c.legs.push(leg);
    else {
      same.facts = { ...same.facts, ...leg.facts };
      if (leg.class !== "PROVEN") same.class = leg.class;
    }
  }
  const seen = new Set(c.evidence.map((e) => e.id));
  c.evidence.push(...found.evidence.filter((e) => !seen.has(e.id)));
  c.claims.push(...found.claims);
  c.identifiers = [...new Set([...c.identifiers, ...found.identifiers])].sort();
}

async function firstAnswer(id, a, ctx) {
  if (id.kind === "omni-transfer") return a.transfer(id.value, ctx);
  const order = await a.order(id.value, ctx);
  if (!order.notFound || id.kind === "deposit-address") return order;
  const omni = await a.transfer(id.value, ctx);
  return omni.notFound ? order : omni;
}

const linked = (legs) => legs.slice(1).map((l, i) => ({ from: legs[i].id, to: l.id, kind: EDGE[l.status] ?? "bridged-as" }));

export async function openCase(raw, ctx) {
  const id = readIdentifier(raw);
  if (id.error) return { error: id.error };
  const a = { ...LIVE, ...ctx.adapters };
  const first = await firstAnswer(id, a, ctx);
  if (first.notFound) return { error: first.notFound };
  const caseData = { identifiers: [], legs: [], edges: [], evidence: [], claims: [] };
  absorb(caseData, first);
  const asked = new Set();
  const queue = [...first.next];
  while (queue.length && asked.size < MAX_HOPS) {
    const link = queue.shift();
    if (asked.has(link.value)) continue;
    asked.add(link.value);
    const found = await a.evmTx(link.chain, link.value, ctx);
    absorb(caseData, found);
    queue.push(...found.next);
  }
  if (id.kind === "deposit-address") {
    const claim = await a.claim(id.value, ctx);
    if (claim) caseData.claims.push(claim);
  }
  caseData.edges = linked(caseData.legs);
  return { caseData, verdict: await buildVerdict(caseData) };
}

/** A recorded case: no network, so it works on stage and in a judge's sandbox. Node only. */
export async function replayCase(dir) {
  const { readFile } = await import("node:fs/promises");
  const caseData = JSON.parse(await readFile(`${dir}/case.json`, "utf8"));
  return { caseData, verdict: await buildVerdict(caseData) };
}
