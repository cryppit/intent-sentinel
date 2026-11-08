// Rules v1 (spec section 6). They run in this order; each may set the journey and the next party. Pure: no clock, no
// network. `at` is when the case was read. A soft rule only fills in a next party when nothing is left open; a settling
// rule never replaces an open one, because a proven payout on one leg says nothing about the others.
import { PARTIES } from "./schema.js";
import { PARTY_WORDS, STATUS_SAYS, legPlace, place, shortRef, stepWords } from "./words.js";

const when = (s) => Date.parse(s);
const isProven = (leg) => leg.class === "PROVEN";
const named = (p) => (PARTIES.includes(p) ? p : "unknown");
const refOf = (leg) => shortRef(leg.ref ?? leg.provider);
const settled = (c) => c.legs.some((l) => isProven(l) && (l.status === "PAID_OUT" || l.status === "REFUNDED"));
const leg = (c, test) => c.legs.find(test) ?? null;
const provider = (key) => PARTY_WORDS[key] && !["user", "none", "unknown", "anyone"].includes(key) ? title(PARTY_WORDS[key]) : place(key)[0];
const title = (s) => s[0].toUpperCase() + s.slice(1);

const PRIVATE_FRESH_MS = 3600_000;
const privateFresh = (l, at) => Boolean(l?.at) && when(at) - when(l.at) <= PRIVATE_FRESH_MS;

const RULES = [
  {
    code: "SOURCE_NOT_SEEN",
    fires: (c) => leg(c, (l) => l.status === "DEPOSIT_NOT_FOUND"),
    party: () => "user",
    question: () => "We can't find a deposit to this address. Was it sent to this exact address, on the network your swap app asked for?",
    ask: () => ["the transaction ID (hash) of your deposit, from your wallet", "which network you sent it on"],
  },
  {
    code: "CREDIT_PENDING",
    fires: (c, at) => leg(c, (l) => l.status === "CREDIT_PENDING" && l.window && when(l.window.dueBy) < when(at)),
    party: (c, l) => (l.provider === "omni" ? "omni-relayer" : "near-intents"),
    question: (c, l) => `${refOf(l)} hasn't reached NEAR in the expected time. Why not?`,
    ask: () => ["what the bridge shows for this deposit"],
  },
  {
    code: "BALANCE_HELD",
    fires: (c, at) => leg(c, (l) => l.status === "HELD" && l.window && when(l.window.dueBy) < when(at)),
    party: () => "near-intents",
    question: () => "Your coins are still waiting in NEAR Intents, and the swap's price offer has run out. When will they be refunded?",
    ask: () => ["the swap's price offer (quote) and the refund address they have for this swap"],
  },
  { code: "PAID_OUT", settles: true, fires: (c) => leg(c, (l) => isProven(l) && (l.status === "PAID_OUT" || l.status === "FINALISED")), party: () => "none", question: () => null, ask: () => [] },
  { code: "REFUNDED", settles: true, fires: (c) => leg(c, (l) => isProven(l) && l.status === "REFUNDED"), party: () => "none", question: () => null, ask: () => [] },
  {
    code: "FINISH_REPORTED",
    fires: (c) => leg(c, (l) => l.status === "FINALISED" && !isProven(l)),
    party: () => "unknown",
    question: (c, l) => `The bridge's own records say ${refOf(l)} finished, but we couldn't confirm it on the blockchain. Did the money arrive?`,
    ask: () => ["the transaction ID of the payment on the receiving network"],
  },
  {
    code: "RECIPIENT_IS_CONTRACT",
    soft: true,
    fires: (c) => leg(c, (l) => l.facts?.recipientIsContract),
    party: () => "unknown",
    question: () => "The payout went to an address that runs code (a smart contract, which can be a smart wallet). Where did it send the money next?",
    ask: () => ["who controls that receiving address"],
  },
  {
    code: "DOWNSTREAM_PROVIDER_DETECTED",
    fires: (c) => leg(c, (l) => l.facts?.downstreamProvider),
    party: (c, l) => named(l.facts.downstreamProvider),
    question: (c, l) => `Your money was passed on to ${provider(l.facts.downstreamProvider)} (another swap network). Did it pay the money out?`,
    ask: (c, l) => [`${provider(l.facts.downstreamProvider)}'s swap ID, or the transaction that paid you`],
  },
  {
    code: "DOWNSTREAM_EGRESS_UNVERIFIED",
    fires: (c) => leg(c, (l) => l.status === "INGRESS_CONFIRMED_EGRESS_UNKNOWN"),
    party: (c, l) => named(l.provider),
    question: (c, l) => `${provider(l.provider)} received the deposit. Which transaction paid it out?`,
    ask: () => ["the swap ID, or the transaction that paid you", "which coin and network you expected to receive"],
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
    question: (c, k) => `Your app still shows "${STATUS_SAYS[k.status] ?? k.status}", but the blockchain shows the payout was made. Can the app update the status?`,
    ask: () => ["where the app's status comes from"],
  },
  {
    code: "STATUS_EVIDENCE_MISMATCH",
    from: "REPORTED",
    fires: (c) => (leg(c, (l) => isProven(l) && l.status === "PAID_OUT") ? null : c.claims.find((k) => k.status === "SUCCESS") ?? null),
    party: () => "near-intents",
    question: () => "1Click (the swap service) reports this swap as done, but we can't find proof of the payment to the receiving address. Which transaction paid it?",
    ask: () => ["the transaction ID of the payment"],
  },
  {
    code: "CONSERVATION_MISMATCH",
    fires: (c, at, r) => r.conservation.find((x) => x.ok === false) ?? null,
    party: () => "unknown",
    question: (c, x) => `The amounts on ${legPlace(x.leg)} don't add up. What explains the difference?`,
    ask: () => ["any fees, or other payments made from this step"],
  },
  {
    code: "PERMISSIONLESS_FINISH",
    fires: (c) => leg(c, (l) => l.finish?.by === "anyone" && isProven(l)),
    party: () => "anyone",
    question: (c, l) => `The last step is open: anyone, including you, can ${stepWords(l.finish.step, refOf(l))}. Who will?`,
    ask: () => [],
  },
  {
    code: "GATED_FINISH",
    fires: (c) => leg(c, (l) => l.finish && l.finish.by !== "anyone"),
    party: (c, l) => named(l.finish.by),
    question: (c, l) => `Only ${PARTY_WORDS[l.finish.by] ?? l.finish.by}${l.finish.by === "omni-relayer" ? " (the bridge's operator)" : ""} can ${stepWords(l.finish.step, refOf(l))}. Will it?`,
    ask: () => ["whether they will process this transfer, and when"],
  },
  {
    code: "RAIL_PAUSED",
    from: (l) => (l.facts.railPaused.routeProven ? "PROVEN" : "INFERRED"),
    fires: (c) => (settled(c) ? null : leg(c, (l) => l.facts?.railPaused)),
    party: (c, l) => named(l.facts.railPaused.rail),
    question: (c, l) => `${provider(l.facts.railPaused.rail)} was paused while your swap was running. Is it working again?`,
    ask: (c, l) => [`whether your swap went through ${provider(l.facts.railPaused.rail)}`],
  },
  {
    code: "TRACE_WARNING",
    // A note that asks nobody to act (party "none") is shown, but doesn't decide the case.
    fires: (c) => c.warnings?.find((w) => w.party !== "none") ?? null,
    party: (c, w) => named(w.party),
    question: (c, w) => w.detail,
    ask: () => [],
  },
  {
    // A private step that came back out to a proven payout is done. One that is minutes old is still being settled by
    // NEAR Intents. One that never came back can only be explained by NEAR Intents or the signed-in owner.
    code: "NOT_VISIBLE",
    fires: (c, at) => {
      // A private step the money already came back out of is resolved; what's left is the payout's own question.
      const hidden = settled(c) ? null : leg(c, (l) => l.class === "NOT_VISIBLE" && !l.facts?.privateRoundTrip);
      return hidden && { ...hidden, fresh: privateFresh(hidden, at) };
    },
    party: (c, l) => (l.fresh ? "near-intents" : "user"),
    question: (c, l) =>
      l.fresh
        ? "This step is happening privately on NEAR right now, so nobody outside can see it. The payout usually follows within minutes."
        : "This step happened privately on NEAR. Only NEAR Intents, and you when signed in to NEAR Intents, can see it. Ask NEAR Intents support what happened next.",
    ask: (c, l) => (l.fresh ? [] : ["the status of this swap", "what you see for this step when you sign in to NEAR Intents"]),
    youCan: (c, l) => (l.fresh ? ["check this ID again in 10 minutes"] : []),
  },
];

const OPEN = { journey: "INSUFFICIENT_EVIDENCE", party: "unknown" };
const ASK_MORE = { party: "unknown", question: "One of the public records didn't answer, or couldn't prove a step, so we can't finish the check.", evidenceToAsk: [], youCan: ["try again in a few minutes", "paste another ID from the same swap, such as your deposit transaction"] };

// How long after the credit an unseen payout is still most likely on its way. Bitcoin and Zcash withdrawals are slower.
const PENDING_MS = { btc: 3 * 3600_000, zec: 3 * 3600_000 };
const PENDING_DEFAULT_MS = 3600_000;
const WAIT = (slow) => ({ party: "unknown", question: "The payout isn't proven yet. The money reached NEAR Intents recently, so the payout is probably still on its way.", evidenceToAsk: [], youCan: [slow ? "check this ID again in an hour (Bitcoin and Zcash payouts are slower)" : "check this ID again in 15 minutes"] });
// Not seen yet, or seen but not confirmed (e.g. a Bitcoin payout still in the mempool).
const awaited = (l) => l.status === "PAYOUT_UNSEEN" || (l.status === "PAID_OUT" && !isProven(l));
const young = (l, at) => awaited(l) && l.at && when(at) - when(l.at) <= (PENDING_MS[l.provider] ?? PENDING_DEFAULT_MS);

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
    const youCan = rule.youCan?.(caseData, hit) ?? [];
    const action = { party: rule.party(caseData, hit), question: rule.question(caseData, hit), evidenceToAsk: rule.ask(caseData, hit), ...(youCan.length ? { youCan } : {}) };
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
    const open = caseData.legs.filter(unproven);
    if (!failed && open.length && open.every((l) => young(l, at))) {
      r.findings.push("PAYOUT_PENDING");
      r.findingClasses.PAYOUT_PENDING = "INFERRED";
      r.nextAction = WAIT(open.some((l) => PENDING_MS[l.provider]));
    }
  }
  return r;
}
