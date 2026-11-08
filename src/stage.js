// What the route picture shows, kept pure so it can be tested. The coin only passes a stop that is proven.
import { PARTY_WORDS, CLASS_WORDS, place, placeName, table } from "./words.js";
import { STATUS_WORDS } from "./render-text.js";

export { placeName };

const BOARD = [["user", "You"], ["integrator", "Your app"], ["near-intents", "NEAR Intents"], ["omni-relayer", "Omni relayer"], ["anyone", "Anyone"], ["none", "Nobody"]];
const EXTRA = table({ chainflip: "Chainflip", thorchain: "THORChain", unknown: "Can't name yet" });
const REACHED = new Set(["DEPOSIT_CONFIRMED", "CREDITED", "PAID_OUT", "REFUNDED", "FINALISED", "CONTRACT_FORWARDED"]);
const LAST_STOP = new Set(["PAID_OUT", "REFUNDED", "FINALISED", "PAYOUT_UNSEEN"]);
const title = (s) => s[0].toUpperCase() + s.slice(1);

const toneOf = (verdict) => (verdict.journey === "INSUFFICIENT_EVIDENCE" ? "unknown" : verdict.nextAction.party === "none" ? "done" : "act");

export function stageView(caseData, verdict) {
  const tone = toneOf(verdict);
  const { party } = verdict.nextAction;
  // A tick means proven, always. A stop that isn't proven but sits before one that is gets no tick and doesn't stop the coin.
  const reached = (l) => l.class === "PROVEN" && REACHED.has(l.status);
  const failedAt = caseData.legs.findIndex((l) => l.status === "LOOKUP_FAILED");
  const readable = failedAt < 0 ? caseData.legs : caseData.legs.slice(0, failedAt);
  const lastProven = readable.map(reached).lastIndexOf(true);
  let stopped = false;
  const stateOf = (l, i) => {
    if (i <= lastProven) return reached(l) ? "passed" : "seen";
    if (stopped) return "ahead";
    if (tone === "done") return "seen";
    stopped = true;
    return "here";
  };
  const stops = caseData.legs.map((l, i) => {
    const [name, logo] = place(l.provider);
    const state = stateOf(l, i);
    return { name, logo, state, label: STATUS_WORDS[l.status] ?? l.status, class: l.class, classLabel: title(CLASS_WORDS[l.class] ?? l.class), failed: l.status === "LOOKUP_FAILED", custody: l.custody ?? null };
  });
  const first = caseData.legs[0];
  if (first?.facts?.from && first.facts.originProven) {
    const [name, logo] = place(first.facts.from);
    stops.unshift({ name, logo, state: "passed", label: "sent", class: "PROVEN", classLabel: "Proven", failed: false, custody: null });
  }
  const last = caseData.legs.at(-1);
  if (last?.facts?.to && last.status === "FINALISED" && last.class === "PROVEN") {
    const [name, logo] = place(last.facts.to);
    stops.push({ name, logo, state: "passed", label: "arrived", class: "PROVEN", classLabel: "Proven", failed: false, custody: null });
  }
  if (tone !== "done" && !LAST_STOP.has(caseData.legs.at(-1)?.status)) {
    const to = caseData.legs.at(-1)?.facts?.to;
    const [name, logo] = to ? place(to) : ["Destination", null];
    stops.push({ name, logo, state: stopped ? "ahead" : "here", label: stopped ? "not reached yet" : "no proof it arrived yet", class: null, classLabel: null, failed: false, custody: null });
  }
  const holder = stops.filter((s) => (s.state === "passed" || s.state === "here") && s.class === "PROVEN" && s.custody).at(-1);
  const board = BOARD.map(([key, name]) => ({ key, name, lit: key === party }));
  if (!board.some((p) => p.lit)) board.push({ key: party, name: EXTRA[party] ?? PARTY_WORDS[party] ?? party, lit: true });
  return { tone, party, partyName: title(PARTY_WORDS[party] ?? party), parties: board, stops, custody: holder?.custody ?? null };
}
