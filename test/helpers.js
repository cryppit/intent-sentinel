// Small literal cases for the rule tests.
export const AT = "2026-11-06T00:00:00Z";
export const BEFORE = "2026-11-01T00:00:00Z";
export const AFTER = "2026-11-10T00:00:00Z";
export const caseWith = (legs, claims = [], identifiers = ["id-a"]) => ({
  identifiers,
  legs: legs.map((l, i) => ({ id: `leg${i}`, class: "PROVEN", evidence: [], ...l })),
  edges: [],
  evidence: [{ id: "e1", source: "test", kind: "tx", ref: "r", observedAt: AT, class: "PROVEN" }],
  claims,
});
export const paidOutLeg = { provider: "near-intents", status: "PAID_OUT", at: BEFORE };
