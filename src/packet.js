import { canonicalJson, sha256Hex } from "./canon.js";
import { evidenceHash } from "./verdict.js";

// The evidence packet (spec section 8): what a support team can be handed. Its evidence is proven chain records; the
// verdict inside keeps its own labels, including anything only reported. No 1Click payload can get here, because
// claims are reduced to a category in the verdict.
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

/** Checks the packet agrees with itself. Anyone could rebuild one from scratch, so only a rerun or a pin proves it's real. */
export async function verifyPacket(packet) {
  const { outputHash, ...rest } = packet.verdict;
  return outputHash === (await sha256Hex(canonicalJson(rest))) && rest.evidenceHash === (await evidenceHash(packet.evidence));
}
