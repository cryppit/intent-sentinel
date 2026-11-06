// The verdict (spec section 5). The same evidence gives the same bytes.
import { canonicalJson, sha256Hex } from "./canon.js";
import { incidentId } from "./incident.js";
import { evaluate } from "./rules.js";
import { SCHEMA, RULES_VERSION } from "./schema.js";

const latest = (times) => times.reduce((a, b) => (a === null || Date.parse(b) > Date.parse(a) ? b : a), null);

export async function buildVerdict(caseData) {
  // computedAt is the newest chain event, so reading an unchanged case again gives the same bytes. The rules still get
  // the read time: whether a window has passed depends on when we looked.
  const computedAt = latest(caseData.evidence.filter((e) => e.kind !== "read").map((e) => e.observedAt));
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
    claims: caseData.claims.map(({ by, status, observedAt, class: cls }) => ({ by, status, observedAt, class: cls })),
    ...(caseData.warnings?.length ? { warnings: caseData.warnings.map(({ kind, detail }) => ({ kind, detail })) } : {}),
  };
  return { ...verdict, outputHash: await sha256Hex(canonicalJson(verdict)) };
}
