// The verdict (spec section 5). computedAt is the latest evidence time, so the same evidence gives the same bytes.
import { canonicalJson, sha256Hex } from "./canon.js";
import { incidentId } from "./incident.js";
import { evaluate } from "./rules.js";
import { SCHEMA, RULES_VERSION } from "./schema.js";

const latest = (times) => times.reduce((a, b) => (a === null || Date.parse(b) > Date.parse(a) ? b : a), null);

export async function buildVerdict(caseData) {
  const computedAt = latest([...caseData.evidence, ...caseData.claims].map((e) => e.observedAt));
  const { journey, nextAction, findings, findingClasses, conservation } = evaluate(caseData, computedAt);
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
    claims: caseData.claims.map(({ by, status, observedAt, class: cls }) => ({ by, status, observedAt, class: cls })),
  };
  return { ...verdict, outputHash: await sha256Hex(canonicalJson(verdict)) };
}
