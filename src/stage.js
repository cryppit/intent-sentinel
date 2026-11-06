// What the route picture shows, kept pure so it can be tested. The coin only passes a stop that is proven.
import { PARTY_WORDS, CLASS_WORDS } from "./words.js";
import { STATUS_WORDS } from "./render-text.js";

const PLACES = {
  near: ["NEAR", "near-protocol"], eth: ["Ethereum", "ethereum"], sol: ["Solana", "solana"], btc: ["Bitcoin", "bitcoin"], base: ["Base", "base"],
  arb: ["Arbitrum", "arbitrum-one"], bsc: ["BNB Chain", "binance-smart-chain"], bnb: ["BNB Chain", "binance-smart-chain"], tron: ["TRON", "tron"],
  zec: ["Zcash", "token-zec"], zcash: ["Zcash", "token-zec"], pol: ["Polygon", "polygon"], avax: ["Avalanche", "avalanche"], op: ["OP Mainnet", "optimism"],
  gnosis: ["Gnosis", "gnosis"], xrp: ["XRP Ledger", "xrp"], doge: ["Dogecoin", "token-doge"], ltc: ["Litecoin", "litecoin"], bch: ["Bitcoin Cash", "token-bch"],
  ton: ["TON", "ton"], sui: ["Sui", "sui"], ada: ["Cardano", "cardano"], cardano: ["Cardano", "cardano"], aptos: ["Aptos", "aptos"], stellar: ["Stellar", "stellar"],
  strk: ["Starknet", "starknet"], starknet: ["Starknet", "starknet"], abs: ["Abstract", "abstract"], hlevm: ["HyperEVM", "hyper-evm"], fogo: ["Fogo", "token-fogo"],
  bera: ["Berachain", "berachain"], monad: ["Monad", "monad"], plasma: ["Plasma", "plasma"], scroll: ["Scroll", "scroll"],
  "near-intents": ["NEAR Intents", "near-protocol"], omni: ["Omni bridge", null], unknown: ["Unknown source", null],
};
const place = (key) => PLACES[String(key).toLowerCase()] ?? PLACES[String(key).toLowerCase().replace(/ bridge$/, "")] ?? [String(key), null];

export const placeName = (key) => place(key)[0];

const BOARD = [["user", "You"], ["integrator", "Your app"], ["solver", "Solver"], ["near-intents", "NEAR Intents"], ["omni-relayer", "Omni relayer"], ["anyone", "Anyone"], ["none", "Nobody"]];
const EXTRA = { chainflip: "Chainflip", thorchain: "THORChain", unknown: "Can't name yet" };
const REACHED = new Set(["DEPOSIT_CONFIRMED", "CREDITED", "PAID_OUT", "REFUNDED", "FINALISED", "CONTRACT_FORWARDED"]);
const LAST_STOP = new Set(["PAID_OUT", "REFUNDED", "FINALISED", "PAYOUT_UNSEEN"]);
const title = (s) => s[0].toUpperCase() + s.slice(1);

const toneOf = (verdict) => (verdict.journey === "INSUFFICIENT_EVIDENCE" ? "unknown" : verdict.nextAction.party === "none" ? "done" : "act");

export function stageView(caseData, verdict) {
  const tone = toneOf(verdict);
  const { party } = verdict.nextAction;
  let stopped = false;
  const stops = caseData.legs.map((l) => {
    const [name, logo] = place(l.provider);
    const reached = tone === "done" || (l.class === "PROVEN" && REACHED.has(l.status));
    const state = stopped ? "ahead" : reached ? "passed" : "here";
    if (state === "here") stopped = true;
    return { name, logo, state, label: STATUS_WORDS[l.status] ?? l.status, class: l.class, classLabel: title(CLASS_WORDS[l.class] ?? l.class), failed: l.status === "LOOKUP_FAILED", custody: l.custody ?? null };
  });
  const first = caseData.legs[0];
  if (first?.facts?.from && first.class === "PROVEN") {
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
    stops.push({ name, logo, state: stopped ? "ahead" : "here", label: stopped ? "not reached" : "not proven", class: null, classLabel: null, failed: false, custody: null });
  }
  const here = stops.find((s) => s.state === "here");
  const lastPassed = stops.filter((s) => s.state === "passed").at(-1);
  const board = BOARD.map(([key, name]) => ({ key, name, lit: key === party }));
  if (!board.some((p) => p.lit)) board.push({ key: party, name: EXTRA[party] ?? PARTY_WORDS[party] ?? party, lit: true });
  return { tone, party, partyName: title(PARTY_WORDS[party] ?? party), parties: board, stops, custody: here?.custody ?? lastPassed?.custody ?? null };
}
