// The verdict in plain words: who acts next first, then each leg and how sure we are of it.
import { CLASS_WORDS, PARTY_WORDS } from "./words.js";

export const STATUS_WORDS = {
  DEPOSIT_CONFIRMED: "deposit confirmed", DEPOSIT_NOT_FOUND: "no deposit found", CREDITED: "credited", CREDIT_PENDING: "credit pending",
  HELD: "held", PAID_OUT: "paid out", REFUNDED: "refunded", CONTRACT_FORWARDED: "forwarded by a contract",
  INGRESS_CONFIRMED_EGRESS_UNKNOWN: "received, payout unknown", INITIALISED: "started, not finished", SIGNED: "signed, not finished",
  FINALISED: "finished", NOT_VISIBLE: "confidential", LOOKUP_FAILED: "could not be read",
  PAYOUT_UNSEEN: "payout not found", NOT_PROVEN: "claimed, not proven",
};

export const balanceWords = (x) => (x.ok === null ? `amounts on ${x.leg} not checked (${x.reason})` : `amounts in and out ${x.ok ? "balance" : "do not balance"} on ${x.leg}`);

export function headline(verdict) {
  const { party } = verdict.nextAction;
  if (verdict.journey === "INSUFFICIENT_EVIDENCE") return "We can't give an answer yet: part of this couldn't be read or proven.";
  if (party === "none") return "Nobody needs to act: there's nothing left to do.";
  const who = PARTY_WORDS[party] ?? party;
  return party === "user" ? "You act next." : `Next to act: ${who}.`;
}

export function renderText(verdict) {
  const lines = [headline(verdict)];
  if (verdict.nextAction.question) lines.push(verdict.nextAction.question);
  lines.push("");
  for (const leg of verdict.legs) {
    const words = leg.status === "LOOKUP_FAILED" ? `could not read ${leg.provider}` : `${leg.provider}: ${STATUS_WORDS[leg.status] ?? leg.status}`;
    lines.push(`  ${words} (${CLASS_WORDS[leg.class] ?? leg.class})`);
  }
  for (const c of verdict.claims) lines.push(`  ${c.by} says ${c.status} (reported)`);
  for (const x of verdict.conservation) lines.push(`  ${balanceWords(x)}`);
  for (const w of verdict.warnings ?? []) lines.push(`  warning: ${w.detail}`);
  lines.push("", `Incident ${verdict.incident.slice(0, 16)}…  hash ${verdict.outputHash.slice(0, 16)}…`);
  return lines.join("\n");
}
