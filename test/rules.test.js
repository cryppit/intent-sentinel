import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/rules.js";
import { AT, BEFORE, AFTER, caseWith, paidOutLeg } from "./helpers.js";

const rule = (name, legs, code, party, claims) =>
  test(name, () => {
    const r = evaluate(caseWith(legs, claims), AT);
    assert.ok(r.findings.includes(code), `${code} not in ${r.findings}`);
    assert.equal(r.nextAction.party, party);
  });
const claim = (status, observedAt = AT) => ({ by: "user-report", status, observedAt, class: "REPORTED" });

rule("no deposit sends the user back to check", [{ provider: "tron", status: "DEPOSIT_NOT_FOUND" }], "SOURCE_NOT_SEEN", "user");
rule("a late Omni credit is the relayer's", [{ provider: "omni", status: "CREDIT_PENDING", window: { dueBy: BEFORE } }], "CREDIT_PENDING", "omni-relayer");
rule("a late direct credit is NEAR Intents'", [{ provider: "near-intents", status: "CREDIT_PENDING", window: { dueBy: BEFORE } }], "CREDIT_PENDING", "near-intents");
rule("a balance held past the quote needs a refund", [{ provider: "near-intents", status: "HELD", window: { dueBy: BEFORE } }], "BALANCE_HELD", "near-intents");
rule("a proven payout leaves nothing to do", [paidOutLeg], "PAID_OUT", "none");
rule("a proven refund leaves nothing to do", [{ provider: "near-intents", status: "REFUNDED" }], "REFUNDED", "none");
rule("a contract recipient keeps the case open", [{ ...paidOutLeg, facts: { recipientIsContract: true } }], "RECIPIENT_IS_CONTRACT", "unknown");
rule("a forward to a known provider names it", [paidOutLeg, { provider: "ethereum-recipient", status: "CONTRACT_FORWARDED", facts: { downstreamProvider: "chainflip" } }], "DOWNSTREAM_PROVIDER_DETECTED", "chainflip");
rule("unknown egress stays with the provider", [{ provider: "chainflip", status: "INGRESS_CONFIRMED_EGRESS_UNKNOWN" }], "DOWNSTREAM_EGRESS_UNVERIFIED", "chainflip");
rule("a stale FAILED after payout is the integrator's to refresh", [paidOutLeg], "STATUS_CLAIM_STALE", "integrator", [claim("FAILED", AT)]);
rule("a SUCCESS with no payout goes to NEAR Intents", [{ provider: "near-intents", status: "CREDITED" }], "STATUS_EVIDENCE_MISMATCH", "near-intents", [claim("SUCCESS")]);
rule("an open step anyone may finish", [{ provider: "omni", status: "SIGNED", finish: { step: "finTransfer", by: "anyone" } }], "PERMISSIONLESS_FINISH", "anyone");
rule("a gated step names who holds it", [{ provider: "omni", status: "INITIALISED", finish: { step: "sign_transfer", by: "omni-relayer" } }], "GATED_FINISH", "omni-relayer");
rule("a paused rail names the rail", [{ provider: "near-intents", status: "HELD", facts: { railPaused: { rail: "chainflip" } } }], "RAIL_PAUSED", "chainflip");
rule("a confidential leg goes back to its owner", [{ provider: "near-intents", status: "NOT_VISIBLE", class: "NOT_VISIBLE" }], "NOT_VISIBLE", "user");
rule("a mismatch has no party to blame", [{ provider: "x", status: "CREDITED", amountIn: "10", amountOut: ["9"], decimals: 6 }], "CONSERVATION_MISMATCH", "unknown");
rule("no evidence names nobody", [], "INSUFFICIENT_EVIDENCE", "unknown");

test("a failed lookup never reads as success", () => {
  const r = evaluate(caseWith([paidOutLeg, { provider: "omni", status: "LOOKUP_FAILED", class: "UNKNOWN" }]), AT);
  assert.equal(r.journey, "INSUFFICIENT_EVIDENCE");
  assert.ok(r.findings.includes("PAID_OUT"));
});
test("a reported payout is not a proven one", () =>
  assert.equal(evaluate(caseWith([{ ...paidOutLeg, class: "REPORTED" }]), AT).journey, "INSUFFICIENT_EVIDENCE"));
test("the Omni fee-0 case is gated on the relayer", () => {
  const r = evaluate(caseWith([{ provider: "omni", status: "INITIALISED", ref: "Near:563760", finish: { step: "sign_transfer", by: "omni-relayer" } }]), AT);
  assert.equal(r.journey, "GATED_FINISH");
  assert.match(r.nextAction.question, /sign_transfer/);
  assert.match(r.nextAction.question, /Near:563760/);
});
test("a credit still inside its window is not late", () =>
  assert.ok(!evaluate(caseWith([{ provider: "omni", status: "CREDIT_PENDING", window: { dueBy: AFTER } }]), AT).findings.includes("CREDIT_PENDING")));
test("a claim older than the payout isn't stale", () =>
  assert.ok(!evaluate(caseWith([{ ...paidOutLeg, at: AT }], [claim("FAILED", BEFORE)]), AT).findings.includes("STATUS_CLAIM_STALE")));
test("a stale claim doesn't hide a real open question", () => {
  const legs = [paidOutLeg, { provider: "chainflip", status: "INGRESS_CONFIRMED_EGRESS_UNKNOWN" }];
  assert.equal(evaluate(caseWith(legs, [claim("FAILED")]), AT).nextAction.party, "chainflip");
});
test("a finding from an inferred input carries that class", () => {
  const r = evaluate(caseWith([{ provider: "near-intents", status: "HELD", facts: { railPaused: { rail: "chainflip" } } }]), AT);
  assert.equal(r.findingClasses.RAIL_PAUSED, "INFERRED");
});
test("a finding from a claim is reported, not proven", () =>
  assert.equal(evaluate(caseWith([paidOutLeg], [claim("FAILED")]), AT).findingClasses.STATUS_CLAIM_STALE, "REPORTED"));
test("a settled order isn't blamed on a pause", () =>
  assert.ok(!evaluate(caseWith([{ ...paidOutLeg, facts: { railPaused: { rail: "chainflip" } } }]), AT).findings.includes("RAIL_PAUSED")));
test("conservation holds on huge amounts", () => {
  const leg = { provider: "x", status: "CREDITED", amountIn: "340282366920938463463374607431768211456", amountOut: ["340282366920938463463374607431768211455", "1"], decimals: 24 };
  assert.equal(evaluate(caseWith([leg]), AT).conservation[0].ok, true);
});
test("known fees count towards the balance", () =>
  assert.equal(evaluate(caseWith([{ provider: "x", status: "CREDITED", amountIn: "10", amountOut: ["9"], fees: ["1"], decimals: 6 }]), AT).conservation[0].ok, true));
test("a mismatch is flagged, never balanced", () =>
  assert.ok(evaluate(caseWith([{ provider: "x", status: "CREDITED", amountIn: "10", amountOut: ["9"], decimals: 6 }]), AT).findings.includes("CONSERVATION_MISMATCH")));
test("an amount that isn't an integer fails the check instead of throwing", () =>
  assert.equal(evaluate(caseWith([{ provider: "x", status: "CREDITED", amountIn: "1.5", amountOut: ["1"], decimals: 6 }]), AT).conservation[0].ok, false));
test("two legs paid and part refunded both appear", () => {
  const legs = [
    { provider: "a", status: "PAID_OUT", amountIn: "6", amountOut: ["6"], decimals: 6 },
    { provider: "b", status: "REFUNDED", amountIn: "4", amountOut: ["4"], decimals: 6 },
  ];
  assert.equal(evaluate(caseWith(legs), AT).conservation.length, 2);
});
test("a party outside the vocabulary becomes unknown", () =>
  assert.equal(evaluate(caseWith([{ provider: "hyperliquid", status: "INGRESS_CONFIRMED_EGRESS_UNKNOWN" }]), AT).nextAction.party, "unknown"));
