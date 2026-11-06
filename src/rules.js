// Rules v1 (spec section 6). They run in this order; each may set the journey and the next party. Pure: no clock, no
// network. `at` is when the case was read. A soft rule only fills in a next party when nothing is left open; a settling
// rule never replaces an open one, because a proven payout on one leg says nothing about the others.
import { PARTIES } from "./schema.js";
import { PARTY_WORDS, shortRef } from "./words.js";

const when = (s) => Date.parse(s);
const isProven = (leg) => leg.class === "PROVEN";
const named = (p) => (PARTIES.includes(p) ? p : "unknown");
const refOf = (leg) => shortRef(leg.ref ?? leg.provider);
const settled = (c) => c.legs.some((l) => isProven(l) && (l.status === "PAID_OUT" || l.status === "REFUNDED"));
const leg = (c, test) => c.legs.find(test) ?? null;

const RULES = [
  {
    code: "SOURCE_NOT_SEEN",
    fires: (c) => leg(c, (l) => l.status === "DEPOSIT_NOT_FOUND"),
    party: () => "user",
    question: () => "Was the deposit sent to this address, on this network?",
    ask: () => ["source transaction hash", "the network it was sent on"],
  },
  {
    code: "CREDIT_PENDING",
    fires: (c, at) => leg(c, (l) => l.status === "CREDIT_PENDING" && l.window && when(l.window.dueBy) < when(at)),
    party: (c, l) => (l.provider === "omni" ? "omni-relayer" : "near-intents"),
    question: (c, l) => `Why has ${refOf(l)} not been credited on NEAR?`,
    ask: () => ["the deposit's status on the rail"],
  },
  {
    code: "BALANCE_HELD",
    fires: (c, at) => leg(c, (l) => l.status === "HELD" && l.window && when(l.window.dueBy) < when(at)),
    party: () => "near-intents",
    question: () => "This balance is still held after the quote expired. When will it be refunded?",
    ask: () => ["the order's quote and refund address"],
  },
  { code: "PAID_OUT", settles: true, fires: (c) => leg(c, (l) => isProven(l) && (l.status === "PAID_OUT" || l.status === "FINALISED")), party: () => "none", question: () => null, ask: () => [] },
  { code: "REFUNDED", settles: true, fires: (c) => leg(c, (l) => isProven(l) && l.status === "REFUNDED"), party: () => "none", question: () => null, ask: () => [] },
  {
    code: "FINISH_REPORTED",
    fires: (c) => leg(c, (l) => l.status === "FINALISED" && !isProven(l)),
    party: () => "unknown",
    question: (c, l) => `The bridge's indexer says ${refOf(l)} finished, but no chain read confirms it here. Did it arrive?`,
    ask: () => ["the destination transaction"],
  },
  {
    code: "RECIPIENT_IS_CONTRACT",
    soft: true,
    fires: (c) => leg(c, (l) => l.facts?.recipientIsContract),
    party: () => "unknown",
    question: () => "The payout went to a contract. Where did that contract send it next?",
    ask: () => ["who controls the recipient contract"],
  },
  {
    code: "DOWNSTREAM_PROVIDER_DETECTED",
    fires: (c) => leg(c, (l) => l.facts?.downstreamProvider),
    party: (c, l) => named(l.facts.downstreamProvider),
    question: (c, l) => `The funds moved on to ${l.facts.downstreamProvider}. Did it pay them out?`,
    ask: () => ["the provider's swap id or egress transaction"],
  },
  {
    code: "DOWNSTREAM_EGRESS_UNVERIFIED",
    fires: (c) => leg(c, (l) => l.status === "INGRESS_CONFIRMED_EGRESS_UNKNOWN"),
    party: (c, l) => named(l.provider),
    question: (c, l) => `${l.provider} received the deposit. Which transaction paid it out?`,
    ask: () => ["the swap id or egress transaction", "the intended final asset and network"],
  },
  {
    code: "STATUS_CLAIM_STALE",
    soft: true,
    from: "REPORTED",
    fires: (c) => {
      const paid = leg(c, (l) => isProven(l) && l.status === "PAID_OUT");
      if (!paid) return null;
      return c.claims.find((k) => ["FAILED", "PENDING"].includes(k.status) && (!paid.at || when(k.observedAt) >= when(paid.at))) ?? null;
    },
    party: () => "integrator",
    question: (c, k) => `A ${k.status} status is still shown after a proven payout. Can it be refreshed?`,
    ask: () => ["the record behind the status"],
  },
  {
    code: "STATUS_EVIDENCE_MISMATCH",
    from: "REPORTED",
    fires: (c) => (leg(c, (l) => isProven(l) && l.status === "PAID_OUT") ? null : c.claims.find((k) => k.status === "SUCCESS") ?? null),
    party: () => "near-intents",
    question: () => "SUCCESS is reported, but no destination transfer is proven. Which transaction paid it?",
    ask: () => ["the destination transaction hash"],
  },
  {
    code: "CONSERVATION_MISMATCH",
    fires: (c, at, r) => r.conservation.find((x) => x.ok === false) ?? null,
    party: () => "unknown",
    question: (c, x) => `Amounts on ${x.leg} don't add up. What accounts for the difference?`,
    ask: () => ["fees or other outputs of this leg"],
  },
  {
    code: "PERMISSIONLESS_FINISH",
    fires: (c) => leg(c, (l) => l.finish?.by === "anyone"),
    party: () => "anyone",
    question: (c, l) => `${l.finish.step} can be run by anyone for ${refOf(l)}. Who will run it?`,
    ask: () => [],
  },
  {
    code: "GATED_FINISH",
    fires: (c) => leg(c, (l) => l.finish && l.finish.by !== "anyone"),
    party: (c, l) => named(l.finish.by),
    question: (c, l) => `Only ${PARTY_WORDS[l.finish.by] ?? l.finish.by} can run ${l.finish.step}. Will it run for ${refOf(l)}?`,
    ask: () => ["whether this transfer will be processed"],
  },
  {
    code: "RAIL_PAUSED",
    from: (l) => (l.facts.railPaused.routeProven ? "PROVEN" : "INFERRED"),
    fires: (c) => (settled(c) ? null : leg(c, (l) => l.facts?.railPaused)),
    party: (c, l) => named(l.facts.railPaused.rail),
    question: (c, l) => `${l.facts.railPaused.rail} was paused during this order. Has it restarted?`,
    ask: () => ["whether this order used that rail"],
  },
  {
    code: "TRACE_WARNING",
    fires: (c) => c.warnings?.[0] ?? null,
    party: (c, w) => named(w.party),
    question: (c, w) => w.detail,
    ask: () => [],
  },
  {
    code: "NOT_VISIBLE",
    fires: (c) => leg(c, (l) => l.class === "NOT_VISIBLE"),
    party: () => "user",
    question: () => "This leg is confidential. Only its owner can read it.",
    ask: () => ["the owner's own view of this leg"],
  },
];

const OPEN = { journey: "INSUFFICIENT_EVIDENCE", party: "unknown" };
const ASK_MORE = { party: "unknown", question: "What could not be read, and can it be checked again?", evidenceToAsk: ["a retry, or another identifier for this order"] };

const SETTLED = ["PAID_OUT", "REFUNDED"];
const STILL_OPEN = ["PAYOUT_UNSEEN", "NOT_PROVEN", "HELD", "CREDIT_PENDING"];
const unproven = (l) => (SETTLED.includes(l.status) && !isProven(l)) || STILL_OPEN.includes(l.status);

function conservationOf(legs) {
  const out = [];
  for (const l of legs) {
    if (l.unchecked) out.push({ leg: l.id ?? l.provider, ok: null, reason: l.unchecked });
    if (l.amountIn === undefined || l.amountOut === undefined) continue;
    const outs = [l.amountOut].flat();
    const fees = l.fees ?? [];
    let ok = false;
    try {
      ok = BigInt(l.amountIn) === [...outs, ...fees].reduce((sum, a) => sum + BigInt(a), 0n);
    } catch {
      ok = false;
    }
    out.push({ leg: l.id ?? l.provider, in: l.amountIn, out: outs, decimals: l.decimals, ok });
  }
  return out;
}

export function evaluate(caseData, at) {
  const r = { journey: null, nextAction: null, findings: [], findingClasses: {}, conservation: conservationOf(caseData.legs) };
  for (const rule of RULES) {
    const hit = rule.fires(caseData, at, r);
    if (!hit) continue;
    r.findings.push(rule.code);
    r.findingClasses[rule.code] = typeof rule.from === "function" ? rule.from(hit) : rule.from ?? hit.class ?? "PROVEN";
    const action = { party: rule.party(caseData, hit), question: rule.question(caseData, hit), evidenceToAsk: rule.ask(caseData, hit) };
    if (rule.soft) {
      if (!r.nextAction || r.nextAction.party === "none") r.nextAction = action;
    } else if (!rule.settles || !r.journey || SETTLED.includes(r.journey)) {
      r.journey = rule.code;
      r.nextAction = action;
    }
  }
  const failed = caseData.legs.some((l) => l.status === "LOOKUP_FAILED");
  const halfProven = SETTLED.includes(r.journey) && caseData.legs.some(unproven);
  if (failed || !r.journey || halfProven) {
    r.findings.push(OPEN.journey);
    r.findingClasses[OPEN.journey] = "UNKNOWN";
    r.journey = OPEN.journey;
    r.nextAction = ASK_MORE;
  }
  return r;
}
