import { canonicalJson, sha256Hex } from "./canon.js";
import { evidenceHash } from "./verdict.js";

// The evidence packet (spec section 8): what a support team can be handed. Its evidence is proven chain records; the
// verdict inside keeps its own labels, including anything only reported. No 1Click payload can get here, because
// claims are reduced to a category in the verdict.
const record = ({ id, source, kind, ref, observedAt, class: cls, undated }) => ({ id, source, kind, ref, observedAt: undated ? null : observedAt, class: cls, ...(undated ? { undated } : {}) });
const when = (at) => Date.parse(at ?? "9999-01-01");

function assemble(verdict, evidence) {
  const records = evidence.filter((e) => e.class === "PROVEN" && e.kind !== "read").map(record);
  const timeline = records.map(({ observedAt, source, kind, ref }) => ({ at: observedAt, source, kind, ref })).sort((x, y) => when(x.at) - when(y.at));
  const { question, evidenceToAsk } = verdict.nextAction;
  return { verdict, evidence: records, timeline, openQuestions: question ? [{ question, evidenceToAsk }] : [] };
}

export const buildPacket = (caseData, verdict) => assemble(verdict, caseData.evidence);

/** What goes in the daily root: the whole packet, so changing the evidence is caught as well as changing the verdict. */
export const packetHash = (packet) => sha256Hex(canonicalJson(packet));

/** Checks the packet agrees with itself. Anyone could rebuild one from scratch, so only a rerun or a pin proves it's real. */
export async function verifyPacket(packet) {
  const { outputHash, ...rest } = packet.verdict;
  if (outputHash !== (await sha256Hex(canonicalJson(rest))) || rest.evidenceHash !== (await evidenceHash(packet.evidence))) return false;
  return canonicalJson(assemble(packet.verdict, packet.evidence)) === canonicalJson(packet);
}
