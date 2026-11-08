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
  assert.match(r.nextAction.question, /approve Near:563760 for payout/);
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
test("a question names the party in plain words", () => {
  const r = evaluate(caseWith([{ provider: "omni", status: "INITIALISED", ref: "Near:7", finish: { step: "sign_transfer", by: "omni-relayer" } }]), AT);
  assert.match(r.nextAction.question, /^Only an Omni relayer \(the bridge's operator\) can /);
});
test("a long hash is shortened in a question", () => {
  const ref = "3hd4Kzyd7VHQbNpgWamqznJtm9cTyAVhYVA751B8XUtPXQ4M1YpZBNx1gWnHuT1LEW11kttjRAK5geWRgKw7ppE5";
  const r = evaluate(caseWith([{ provider: "omni", status: "INITIALISED", ref, finish: { step: "fin_transfer", by: "omni-relayer" } }]), AT);
  assert.ok(r.nextAction.question.includes("3hd4Kz…ppE5"));
  assert.ok(!r.nextAction.question.includes(ref));
});

// Review fixes
const held = { provider: "near-intents", status: "HELD", window: { dueBy: BEFORE } };
test("a settled leg can't erase an open one", () => {
  const r = evaluate(caseWith([held, paidOutLeg]), AT);
  assert.equal(r.journey, "BALANCE_HELD");
  assert.equal(r.nextAction.party, "near-intents");
});
test("a refund can't erase a missing deposit", () =>
  assert.equal(evaluate(caseWith([{ provider: "tron", status: "DEPOSIT_NOT_FOUND" }, { provider: "x", status: "REFUNDED" }]), AT).nextAction.party, "user"));
test("an inferred end leg stops a case reading as finished", () =>
  assert.equal(evaluate(caseWith([paidOutLeg, { provider: "x", status: "REFUNDED", class: "INFERRED" }]), AT).journey, "INSUFFICIENT_EVIDENCE"));
test("a payout nobody found stops a case reading as finished", () =>
  assert.equal(evaluate(caseWith([paidOutLeg, { provider: "x", status: "PAYOUT_UNSEEN", class: "UNKNOWN" }]), AT).journey, "INSUFFICIENT_EVIDENCE"));
test("a proven finished Omni transfer has nothing left to do", () => {
  const r = evaluate(caseWith([{ provider: "omni", status: "FINALISED" }]), AT);
  assert.equal(r.journey, "PAID_OUT");
  assert.equal(r.nextAction.party, "none");
});
test("a finish only the indexer reports isn't called done", () => {
  const r = evaluate(caseWith([{ provider: "omni", status: "FINALISED", class: "REPORTED" }]), AT);
  assert.equal(r.journey, "FINISH_REPORTED");
  assert.notEqual(r.nextAction.party, "none");
});
test("a tracer warning outranks a settled order", () => {
  const c = caseWith([paidOutLeg]);
  c.warnings = [{ kind: "destination_missing", party: "user", detail: "no NEAR account is named x yet" }];
  const r = evaluate(c, AT);
  assert.equal(r.journey, "TRACE_WARNING");
  assert.equal(r.nextAction.party, "user");
  assert.match(r.nextAction.question, /no NEAR account/);
});
test("an unchecked balance is shown, and isn't a mismatch", () => {
  const r = evaluate(caseWith([{ provider: "x", status: "CREDITED", unchecked: "a swap changes the token" }, paidOutLeg]), AT);
  assert.equal(r.conservation[0].ok, null);
  assert.equal(r.conservation[0].reason, "a swap changes the token");
  assert.ok(!r.findings.includes("CONSERVATION_MISMATCH"));
});

// A payout that hasn't shown up soon after the credit is most likely still on its way. Say so, but never call it done.
const minsBefore = (m) => new Date(Date.parse(AT) - m * 60_000).toISOString();
const credited = { provider: "near-intents", status: "CREDITED" };
const unseen = (provider, m) => ({ provider, status: "PAYOUT_UNSEEN", class: "UNKNOWN", at: minsBefore(m) });
test("a payout unseen minutes after the credit reads as still on its way", () => {
  const r = evaluate(caseWith([credited, unseen("bsc", 10)]), AT);
  assert.equal(r.journey, "INSUFFICIENT_EVIDENCE");
  assert.ok(r.findings.includes("PAYOUT_PENDING"), r.findings.join());
  assert.match(r.nextAction.question, /on its way/);
  assert.match(r.nextAction.youCan.join(), /again/);
});
test("a payout unseen hours after the credit is not called on its way", () => {
  const r = evaluate(caseWith([credited, unseen("bsc", 120)]), AT);
  assert.ok(!r.findings.includes("PAYOUT_PENDING"));
  assert.match(r.nextAction.question, /didn't answer/);
});
test("a Bitcoin payout gets a longer wait than a fast chain", () => {
  assert.ok(evaluate(caseWith([credited, unseen("btc", 120)]), AT).findings.includes("PAYOUT_PENDING"));
  assert.ok(!evaluate(caseWith([credited, unseen("btc", 240)]), AT).findings.includes("PAYOUT_PENDING"));
});
test("a failed read is never excused as a payout on its way", () => {
  const r = evaluate(caseWith([credited, unseen("bsc", 10), { provider: "x", status: "LOOKUP_FAILED", class: "UNKNOWN" }]), AT);
  assert.ok(!r.findings.includes("PAYOUT_PENDING"));
});
test("an unseen payout with no time is not called on its way", () => {
  const r = evaluate(caseWith([credited, { provider: "bsc", status: "PAYOUT_UNSEEN", class: "UNKNOWN" }]), AT);
  assert.ok(!r.findings.includes("PAYOUT_PENDING"));
});

// Since 27 Oct 2026 1Click swaps settle on NEAR's private shard. A private step is never guessed at, and it doesn't
// undo a payout proven after it.
const privateStep = (m) => ({ provider: "near-intents", status: "NOT_VISIBLE", class: "NOT_VISIBLE", ...(m === undefined ? {} : { at: minsBefore(m) }) });
test("a private step that came back out to a proven payout doesn't reopen the case", () => {
  const r = evaluate(caseWith([credited, privateStep(30), { provider: "tron", status: "PAID_OUT", at: AT }]), AT);
  assert.equal(r.journey, "PAID_OUT");
  assert.equal(r.nextAction.party, "none");
});
test("a private step minutes old is still being settled by NEAR Intents", () => {
  const r = evaluate(caseWith([credited, privateStep(5)]), AT);
  assert.equal(r.nextAction.party, "near-intents");
  assert.match(r.nextAction.question, /privately/);
  assert.match(r.nextAction.youCan.join(), /check this ID again/i);
});
test("a private step that never came back sends the owner to NEAR Intents support", () => {
  const r = evaluate(caseWith([credited, privateStep(180)]), AT);
  assert.equal(r.nextAction.party, "user");
  assert.match(r.nextAction.question, /NEAR Intents support/);
});
test("a private step that came back out never sends a payout still on its way to support", () => {
  const roundTrip = { provider: "near-intents", status: "NOT_VISIBLE", class: "NOT_VISIBLE", facts: { privateRoundTrip: true } };
  const r = evaluate(caseWith([credited, roundTrip, unseen("btc", 1)]), AT);
  assert.ok(r.findings.includes("PAYOUT_PENDING"), r.findings.join());
  assert.doesNotMatch(r.nextAction.question, /support/);
});
test("a private step that came back out leaves an unproven payout to the payout's own rules", () => {
  const roundTrip = { provider: "near-intents", status: "NOT_VISIBLE", class: "NOT_VISIBLE", facts: { privateRoundTrip: true } };
  const r = evaluate(caseWith([credited, roundTrip, { provider: "btc", status: "PAID_OUT", class: "INFERRED" }]), AT);
  assert.ok(!r.findings.includes("NOT_VISIBLE"), r.findings.join());
});
test("a payout seen but not yet confirmed, soon after the credit, is on its way", () => {
  const r = evaluate(caseWith([credited, { provider: "btc", status: "PAID_OUT", class: "INFERRED", at: minsBefore(5) }]), AT);
  assert.equal(r.journey, "INSUFFICIENT_EVIDENCE");
  assert.ok(r.findings.includes("PAYOUT_PENDING"), r.findings.join());
});
test("a payout seen but never confirmed for hours is not called on its way", () => {
  const r = evaluate(caseWith([credited, { provider: "btc", status: "PAID_OUT", class: "INFERRED", at: minsBefore(600) }]), AT);
  assert.ok(!r.findings.includes("PAYOUT_PENDING"));
});
