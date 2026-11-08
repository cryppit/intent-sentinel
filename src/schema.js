// The fixed vocabulary of a verdict. Changing any of these changes what a verdict means, so RULES_VERSION moves with them.
export const SCHEMA = "intent-delivery-verdict/1";
export const RULES_VERSION = "1.6.0";

export const CLASSES = ["PROVEN", "REPORTED", "INFERRED", "UNKNOWN", "NOT_VISIBLE"];

export const PARTIES = ["user", "integrator", "near-intents", "solver", "omni-relayer", "anyone", "chainflip", "thorchain", "none", "unknown"];

export const EDGES = ["deposited-to", "bridged-as", "credited-to", "consumed-by", "paid-to", "forwarded-to", "refunded-to", "claims-status", "contradicts"];

export const LEG_STATUSES = [
  "DEPOSIT_CONFIRMED", "DEPOSIT_NOT_FOUND", "CREDITED", "CREDIT_PENDING", "HELD", "PAID_OUT", "REFUNDED",
  "CONTRACT_FORWARDED", "INGRESS_CONFIRMED_EGRESS_UNKNOWN", "INITIALISED", "SIGNED", "FINALISED", "NOT_VISIBLE", "LOOKUP_FAILED",
  "PAYOUT_UNSEEN", "NOT_PROVEN",
];
