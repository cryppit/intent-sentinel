// Plain words for what a verdict names. Shared by the rules, the CLI and the page.
export const PARTY_WORDS = {
  user: "you", integrator: "the app you swapped through", "near-intents": "NEAR Intents", solver: "the solver",
  "omni-relayer": "an Omni relayer", anyone: "anyone", chainflip: "Chainflip", thorchain: "THORChain", none: "nobody", unknown: "someone we can't name yet",
};
export const shortRef = (ref) => (String(ref).length > 24 ? `${String(ref).slice(0, 6)}…${String(ref).slice(-4)}` : String(ref));
export const CLASS_WORDS = { PROVEN: "proven", REPORTED: "reported", INFERRED: "inferred", UNKNOWN: "unknown", NOT_VISIBLE: "not visible" };
