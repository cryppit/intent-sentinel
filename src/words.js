// Plain words for what a verdict names. Shared by the rules, the CLI and the page.
export const PARTY_WORDS = {
  user: "you", integrator: "the app you swapped through", "near-intents": "NEAR Intents", solver: "the solver (the company that filled your swap)",
  "omni-relayer": "an Omni relayer", anyone: "anyone", chainflip: "Chainflip", thorchain: "THORChain", none: "nobody", unknown: "someone we can't name yet",
};
export const shortRef = (ref) => (String(ref).length > 24 ? `${String(ref).slice(0, 6)}…${String(ref).slice(-4)}` : String(ref));
export const CLASS_WORDS = { PROVEN: "proven", REPORTED: "reported", INFERRED: "inferred", UNKNOWN: "unknown", NOT_VISIBLE: "not visible" };

// Place names and logos for the chains, bridges and services a case passes through.
export const PLACES = {
  near: ["NEAR", "near-protocol"], eth: ["Ethereum", "ethereum"], sol: ["Solana", "solana"], btc: ["Bitcoin", "bitcoin"], base: ["Base", "base"],
  arb: ["Arbitrum", "arbitrum-one"], bsc: ["BNB Chain", "binance-smart-chain"], bnb: ["BNB Chain", "binance-smart-chain"], tron: ["TRON", "tron"],
  zec: ["Zcash", "token-zec"], zcash: ["Zcash", "token-zec"], pol: ["Polygon", "polygon"], avax: ["Avalanche", "avalanche"], op: ["OP Mainnet", "optimism"],
  gnosis: ["Gnosis", "gnosis"], xrp: ["XRP Ledger", "xrp"], doge: ["Dogecoin", "token-doge"], ltc: ["Litecoin", "litecoin"], bch: ["Bitcoin Cash", "token-bch"],
  ton: ["TON", "ton"], sui: ["Sui", "sui"], ada: ["Cardano", "cardano"], cardano: ["Cardano", "cardano"], aptos: ["Aptos", "aptos"], stellar: ["Stellar", "stellar"],
  strk: ["Starknet", "starknet"], starknet: ["Starknet", "starknet"], abs: ["Abstract", "abstract"], hlevm: ["HyperEVM", "hyper-evm"], fogo: ["Fogo", "token-fogo"],
  bera: ["Berachain", "berachain"], monad: ["Monad", "monad"], plasma: ["Plasma", "plasma"], scroll: ["Scroll", "scroll"], hood: ["Robinhood Chain", "robinhood"], xlayer: ["X Layer", null],
  "near-intents": ["NEAR Intents", "near-protocol"], omni: ["Omni bridge", null], "1click": ["1Click", null], "intents.near": ["NEAR Intents balance check", "near-protocol"], unknown: ["Unknown blockchain", null],
};
export const place = (key) => {
  const k = String(key).toLowerCase();
  const record = /^(.+) bridge contract$/.exec(k);
  if (record) return [`${place(record[1])[0]} bridge record`, null];
  return PLACES[k] ?? PLACES[k.replace(/ bridge$/, "")] ?? [String(key), null];
};

export const placeName = (key) => place(key)[0];

/** Bridge steps as plain verbs. The code names stay in the packet's facts, not in what people read. */
export const STEP_WORDS = {
  sign_transfer: (ref) => `approve ${ref} for payout`,
  fin_transfer: (ref) => `complete ${ref} on NEAR`,
  finTransfer: (ref) => `claim ${ref} on the receiving network`,
};
export const stepWords = (step, ref) => (STEP_WORDS[step] ? STEP_WORDS[step](ref) : `finish ${ref}`);

/** Where an internal step id points, for sentences: "credit" is the NEAR Intents balance, "omni:…" the Omni bridge. */
export const legPlace = (id) => (id === "credit" ? "NEAR Intents" : /^omni:/.test(id) ? "the Omni bridge" : /^end:/.test(id) ? "the payout" : place(id)[0]);

/** What a status claim says, in words people use, and who said it. */
export const STATUS_SAYS = { SUCCESS: "done", FAILED: "failed", PENDING: "still in progress", REFUNDED: "refunded", UNKNOWN: "no clear status" };
const CLAIM_BY = { "1click": "1Click (the swap service)", "user-report": "Your report" };
export const claimWords = (c) => `${CLAIM_BY[c.by] ?? c.by} says: ${STATUS_SAYS[c.status] ?? c.status}`;

/** The blockchains for the page's wheel: each once, NEAR first, only those with a logo. Services and bridges are left out. */
const NOT_CHAINS = new Set(["near-intents", "intents.near", "omni", "1click", "unknown"]);
export const wheelChains = () => {
  const seen = new Map();
  for (const [key, [name, logo]] of Object.entries(PLACES)) if (logo && !NOT_CHAINS.has(key) && !seen.has(name)) seen.set(name, { name, logo });
  return [...seen.values()];
};
