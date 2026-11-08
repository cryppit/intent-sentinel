// The verdict in plain words: who acts next first, then each step and how sure we are of it.
import { CLASS_WORDS, PARTY_WORDS, claimWords, legPlace, placeName } from "./words.js";

export const STATUS_WORDS = {
  DEPOSIT_CONFIRMED: "deposit confirmed", DEPOSIT_NOT_FOUND: "no deposit found yet", CREDITED: "received", CREDIT_PENDING: "not received yet",
  HELD: "waiting here", PAID_OUT: "paid out", REFUNDED: "sent back (refund)", CONTRACT_FORWARDED: "passed on by a smart contract",
  INGRESS_CONFIRMED_EGRESS_UNKNOWN: "received; no payout found yet", INITIALISED: "started, not finished", SIGNED: "approved by the bridge, not finished",
  FINALISED: "finished", NOT_VISIBLE: "private step (not public)", LOOKUP_FAILED: "couldn't check",
  PAYOUT_UNSEEN: "no payout found yet", NOT_PROVEN: "reported, not proven",
};

export function balanceWords(x) {
  const at = legPlace(x.leg);
  if (x.ok === null) return /swap|transfer/.test(x.reason ?? "") ? `Amounts at ${at} not compared, because the coins were swapped or moved.` : `Amounts at ${at} not compared (${x.reason}).`;
  return x.ok ? `Amounts match at ${at}: what went in equals what came out.` : `Amounts don't match at ${at}.`;
}

export function headline(verdict) {
  const { party } = verdict.nextAction;
  if (verdict.findings?.includes("PAYOUT_PENDING")) return "No answer yet: the payout is probably still on its way.";
  if (verdict.journey === "INSUFFICIENT_EVIDENCE") return "We can't give an answer yet. Part of the record didn't answer or couldn't be proven.";
  if (party === "none") return "Nobody needs to act: there's nothing left to do.";
  const who = PARTY_WORDS[party] ?? party;
  return party === "user" ? "You need to act next." : `Next to act: ${who}.`;
}

/** Who "Ask …" is addressed to, in a heading. */
export const askWho = (party) => (party === "user" ? "What to ask for" : `What to ask ${PARTY_WORDS[party] ?? party}`);

export function renderText(verdict) {
  const { nextAction } = verdict;
  const lines = [headline(verdict)];
  if (nextAction.question) lines.push(nextAction.question);
  if (nextAction.evidenceToAsk?.length) lines.push(`${askWho(nextAction.party)}: ${nextAction.evidenceToAsk.join("; ")}.`);
  if (nextAction.youCan?.length) lines.push(`What you can do: ${nextAction.youCan.join("; or ")}.`);
  lines.push("");
  for (const leg of verdict.legs) {
    const words = leg.status === "LOOKUP_FAILED" ? `couldn't check ${placeName(leg.provider)}` : `${placeName(leg.provider)}: ${STATUS_WORDS[leg.status] ?? leg.status}`;
    lines.push(`  ${words} (${CLASS_WORDS[leg.class] ?? leg.class})`);
  }
  for (const c of verdict.claims) lines.push(`  ${claimWords(c)} (reported)`);
  for (const x of verdict.conservation) lines.push(`  ${balanceWords(x)}`);
  for (const w of verdict.warnings ?? []) lines.push(`  Note: ${w.detail}`);
  lines.push("", `Case ${verdict.incident.slice(0, 16)}…  fingerprint ${verdict.outputHash.slice(0, 16)}…`);
  return lines.join("\n");
}

/** The CLI's exit code: 0 nothing to do, 2 someone must act, 3 not enough evidence (or a valid ID that can't be checked on
 * its own), 1 bad input. */
export function exitCode(r) {
  if (r.error) return r.notice ? 3 : 1;
  if (r.verdict.journey === "INSUFFICIENT_EVIDENCE") return 3;
  return r.verdict.nextAction.party === "none" ? 0 : 2;
}
