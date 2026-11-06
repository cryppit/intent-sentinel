import { canonicalJson, sha256Hex } from "./canon.js";

// The evidence packet (spec section 8): what a support team can be handed. Proven facts only; no 1Click payload can get
// here, because claims are reduced in the verdict and only PROVEN evidence is copied.
export function buildPacket(caseData, verdict) {
  const proven = caseData.evidence.filter((e) => e.class === "PROVEN");
  const timeline = proven
    .filter((e) => e.kind !== "read")
    .map(({ observedAt, source, kind, ref }) => ({ at: observedAt, source, kind, ref }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const { question, evidenceToAsk } = verdict.nextAction;
  return {
    verdict,
    evidence: proven.map(({ id, source, kind, ref, observedAt, class: cls }) => ({ id, source, kind, ref, observedAt, class: cls })),
    timeline,
    openQuestions: question ? [{ question, evidenceToAsk }] : [],
  };
}

/** What goes in the daily root: the whole packet, so changing the evidence is caught as well as changing the verdict. */
export const packetHash = (packet) => sha256Hex(canonicalJson(packet));

/** Recomputes the verdict's hash, so a packet can't be edited and keep its old one. */
export async function verifyPacket(packet) {
  const { outputHash, ...rest } = packet.verdict;
  return outputHash === (await sha256Hex(canonicalJson(rest)));
}
