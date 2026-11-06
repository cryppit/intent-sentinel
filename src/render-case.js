// What the page shows for a verdict, kept pure so it can be tested. Evidence classes are words, never colour alone.
import { balanceWords, headline, STATUS_WORDS } from "./render-text.js";
import { CLASS_WORDS } from "./words.js";

const EXPLORERS = {
  near: "https://nearblocks.io/txns/", eth: "https://etherscan.io/tx/", sol: "https://solscan.io/tx/", btc: "https://mempool.space/tx/",
  base: "https://basescan.org/tx/", arb: "https://arbiscan.io/tx/", bsc: "https://bscscan.com/tx/", tron: "https://tronscan.org/#/transaction/",
};
const title = (s) => s[0].toUpperCase() + s.slice(1);

export const explorerUrl = (source, ref) => (EXPLORERS[source] ? `${EXPLORERS[source]}${ref}` : null);

function toneOf(verdict) {
  if (verdict.journey === "INSUFFICIENT_EVIDENCE") return "unknown";
  return verdict.nextAction.party === "none" ? "done" : "act";
}

export function caseView(verdict) {
  return {
    headline: headline(verdict),
    question: verdict.nextAction.question,
    ask: verdict.nextAction.evidenceToAsk ?? [],
    party: verdict.nextAction.party,
    tone: toneOf(verdict),
    legs: verdict.legs.map((l) => ({
      provider: l.provider,
      label: STATUS_WORDS[l.status] ?? l.status,
      class: l.class,
      classLabel: title(CLASS_WORDS[l.class] ?? l.class),
      failed: l.status === "LOOKUP_FAILED",
    })),
    claims: verdict.claims.map((c) => `${c.by} says ${c.status}`),
    balances: verdict.conservation.map(balanceWords),
    warnings: (verdict.warnings ?? []).map((w) => w.detail),
  };
}
