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
