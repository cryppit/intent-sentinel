// The verdict (spec section 5). The same evidence gives the same bytes.
import { canonicalJson, sha256Hex } from "./canon.js";
import { incidentId } from "./incident.js";
import { evaluate } from "./rules.js";
import { SCHEMA, RULES_VERSION } from "./schema.js";

/** The proven chain records a case rests on. Read times are left out, so reading an unchanged case again matches. */
export const evidenceHash = (evidence) =>
  sha256Hex(canonicalJson(evidence.filter((e) => e.class === "PROVEN" && e.kind !== "read").map(({ source, kind, ref, observedAt, undated }) => ({ source, kind, ref, ...(undated ? {} : { observedAt }) })).sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1))));

const latest = (times) => times.reduce((a, b) => (a === null || Date.parse(b) > Date.parse(a) ? b : a), null);

export async function buildVerdict(caseData) {
  // computedAt is the newest chain event, so reading an unchanged case again gives the same bytes. The rules still get
  // the read time: whether a window has passed depends on when we looked.
  const computedAt = latest(caseData.evidence.filter((e) => e.kind !== "read" && !e.undated).map((e) => e.observedAt));
  const readAt = latest([...caseData.evidence, ...caseData.claims].map((e) => e.observedAt));
  const { journey, nextAction, findings, findingClasses, conservation } = evaluate(caseData, readAt);
  const verdict = {
    schema: SCHEMA,
    incident: await incidentId(caseData.identifiers),
    computedAt,
    rulesVersion: RULES_VERSION,
    journey,
    nextAction,
    legs: caseData.legs.map(({ provider, status, class: cls, custody }) => ({ provider, status, class: cls, ...(custody ? { custody } : {}) })),
    findings,
    findingClasses,
    conservation,
    claims: caseData.claims.map(({ by, status, class: cls }) => ({ by, status, class: cls })),
    evidenceHash: await evidenceHash(caseData.evidence),
    ...(caseData.warnings?.length ? { warnings: caseData.warnings.map(({ kind, detail }) => ({ kind, detail })) } : {}),
  };
  return { ...verdict, outputHash: await sha256Hex(canonicalJson(verdict)) };
}
