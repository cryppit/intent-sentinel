// apps/wheres-my-swap/src/core/decode.ts
var isRecord = (v) => typeof v === "object" && v !== null;
function failureKind(status) {
  const failure = status["Failure"];
  if (!isRecord(failure)) return void 0;
  const action = failure["ActionError"];
  const kind = isRecord(action) ? action["kind"] : void 0;
  if (typeof kind === "string") return kind;
  if (isRecord(kind)) return Object.keys(kind)[0];
  return Object.keys(failure)[0];
}
function attachedDeposit(actions) {
  let total = 0n;
  for (const a of actions) {
    const x = a;
    const d = x.Transfer?.deposit ?? x.FunctionCall?.deposit;
    if (typeof d === "string" && /^\d+$/.test(d)) total += BigInt(d);
  }
  return total;
}
function decodeArgs(b64) {
  let text;
  try {
    text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return b64;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function decodeActions(actions) {
  const out = [];
  for (const a of actions) {
    const fc = a.FunctionCall;
    if (fc) out.push({ method: fc.method_name, args: decodeArgs(fc.args) });
  }
  return out;
}
function transferDeposits(actions) {
  const out = [];
  for (const a of actions) {
    const t = a.Transfer;
    if (t && typeof t.deposit === "string") out.push(t.deposit);
  }
  return out;
}

// apps/wheres-my-swap/src/core/fastnear.ts
function parseFastnearJson(text) {
  const guarded = text.replace(/"((?:tx_)?block_timestamp)":\s*(\d{16,})/g, '"$1":"$2"');
  return JSON.parse(guarded);
}
function decodeFastnearTx(raw) {
  const nativeTransfers = [];
  const tx = {
    hash: raw.transaction.hash,
    signer: raw.transaction.signer_id,
    receiver: raw.transaction.receiver_id,
    height: raw.execution_outcome.block_height,
    timestampNs: BigInt(String(raw.execution_outcome.block_timestamp)),
    actions: decodeActions(raw.transaction.actions),
    receiptActions: [],
    nativeTransfers,
    events: [],
    plainLogs: []
  };
  const byId = /* @__PURE__ */ new Map();
  for (const r of raw.receipts) if (r.receipt.receipt_id) byId.set(r.receipt.receipt_id, r);
  const sorted = [...raw.receipts].sort((a, b) => a.execution_outcome.block_height - b.execution_outcome.block_height);
  for (const r of sorted) {
    const action = r.receipt.receipt.Action;
    const id = r.receipt.receipt_id;
    const status = r.execution_outcome.outcome.status;
    const failed = "Failure" in status;
    const named = id ? { receipt: id } : {};
    if (action) for (const a of decodeActions(action.actions)) tx.receiptActions.push({ ...a, executor: r.receipt.receiver_id, ...failed ? { failed: true } : {}, ...named });
    if (action && r.receipt.predecessor_id !== "system") {
      const error = failed ? failureKind(status) : void 0;
      const refund = failed ? balanceRefund(r, action.actions, byId) : void 0;
      for (const deposit of transferDeposits(action.actions)) {
        nativeTransfers.push({ from: r.receipt.predecessor_id, to: r.receipt.receiver_id, deposit, failed, ...named, ...error ? { error } : {}, ...refund ? { refund } : {} });
      }
    }
    decodeOutcomeLogs(r.execution_outcome.outcome, tx);
  }
  const pending = pendingReceipts(raw, sorted, byId);
  if (pending.length > 0) tx.pendingReceipts = pending;
  return tx;
}
function pendingReceipts(raw, sorted, byId) {
  if (raw.receipts.some((r) => !r.receipt.receipt_id)) return [];
  const pending = [];
  for (const outcome of [raw.execution_outcome.outcome, ...sorted.map((r) => r.execution_outcome.outcome)]) {
    for (const id of outcome.receipt_ids ?? []) if (!byId.has(id) && !pending.includes(id)) pending.push(id);
  }
  return pending;
}
function balanceRefund(failed, actions, byId) {
  const attached = attachedDeposit(actions);
  if (attached === 0n) return void 0;
  for (const id of failed.execution_outcome.outcome.receipt_ids ?? []) {
    const r = byId.get(id);
    const refund = r?.receipt.receipt.Action;
    if (r && refund && r.receipt.predecessor_id === "system" && r.receipt.receiver_id === failed.receipt.predecessor_id && transferDeposits(refund.actions).some((d) => /^\d+$/.test(d) && BigInt(d) === attached)) return id;
  }
  return void 0;
}
var EVENT_PREFIX = "EVENT_JSON:";
function decodeOutcomeLogs(outcome, tx) {
  const failed = "Failure" in outcome.status;
  const plain = (log) => tx.plainLogs.push({ executor: outcome.executor_id, log, ...failed ? { failed: true } : {} });
  for (const log of outcome.logs) {
    if (!log.startsWith(EVENT_PREFIX)) {
      plain(log);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(log.slice(EVENT_PREFIX.length));
    } catch {
      plain(log);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const ev = parsed;
    if (typeof ev.standard !== "string" || typeof ev.event !== "string") continue;
    const data = Array.isArray(ev.data) ? ev.data : ev.data === void 0 ? [] : [ev.data];
    tx.events.push({
      standard: ev.standard,
      version: typeof ev.version === "string" ? ev.version : "",
      event: ev.event,
      data: data.filter((d) => typeof d === "object" && d !== null),
      executor: outcome.executor_id,
      failed
    });
  }
}

// apps/wheres-my-swap/src/core/chains.ts
var NAMES = {
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  op: "Optimism",
  bsc: "BNB Chain",
  bnb: "BNB Chain",
  pol: "Polygon",
  avax: "Avalanche",
  gnosis: "Gnosis",
  bera: "Berachain",
  monad: "Monad",
  xlayer: "X Layer",
  plasma: "Plasma",
  scroll: "Scroll",
  adi: "ADI Chain",
  hood: "Robinhood Chain",
  abs: "Abstract",
  tron: "TRON",
  btc: "Bitcoin",
  ltc: "Litecoin",
  doge: "Dogecoin",
  bch: "Bitcoin Cash",
  dash: "Dash",
  zec: "Zcash",
  zcash: "Zcash",
  xrp: "XRP Ledger",
  sol: "Solana",
  ton: "TON",
  sui: "Sui",
  stellar: "Stellar",
  aptos: "Aptos",
  cardano: "Cardano",
  starknet: "Starknet",
  hlevm: "HyperEVM",
  hypercore: "Hyperliquid (HyperCore)",
  aleo: "Aleo",
  movement: "Movement",
  qtc: "Quantus",
  fogo: "Fogo",
  near: "NEAR"
};
function chainName(chain) {
  if (!chain) return "?";
  const key = chain.split(":")[0] ?? chain;
  return NAMES[key] ?? chain;
}

// apps/wheres-my-swap/src/core/known-accounts.ts
var CONFIDENTIAL_TREASURY = "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe";
var KNOWN = {
  "7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05": {
    label: "NEAR Intents protocol fee",
    kind: "fee",
    source: "https://docs.near-intents.org/resources/fees"
  },
  "fefundsadmin.sputnik-dao.near": {
    label: "near-intents.org app fee",
    kind: "fee",
    source: "https://docs.near-intents.org/resources/fees"
  },
  [CONFIDENTIAL_TREASURY]: {
    label: "Confidential Intents treasury",
    kind: "confidential",
    source: "https://docs.near-intents.org/integration/market-makers/confidential-intents"
  }
};
function knownAccount(id) {
  return KNOWN[id] ?? null;
}

// apps/wheres-my-swap/src/core/trace.ts
function bounceCause(b) {
  if (b.reason === "unwrap_failed") return `intents.near's own payout step (${b.step ?? "do_native_withdraw"}) failed and sent nothing`;
  return b.error === "AccountDoesNotExist" ? "that account does not exist" : `the transfer failed${b.error ? ` (${b.error})` : ""}`;
}
var KEPT_BY_INTENTS = "NEAR Intents does not credit a failed NEAR payout back: it stays with intents.near, outside the order account";
function bounceDetail(w, b) {
  const dest = w.destination ?? "the destination";
  if (b.reason === "unwrap_failed") return `intents.near's own payout step (${b.step ?? "do_native_withdraw"}) failed, so no NEAR was sent to ${dest}; ${KEPT_BY_INTENTS}`;
  return `NEAR could not deliver the payout to ${dest} (${bounceCause(b)}) and returned it to intents.near${b.refund ? ` (refund receipt ${b.refund})` : ""}; ${KEPT_BY_INTENTS}`;
}
function nativeBounce(tx, dest, amount) {
  const transfers = tx.nativeTransfers;
  if (!transfers || !dest || !amount) return null;
  const toDest = transfers.filter((n) => n.from === "intents.near" && n.to === dest && n.deposit === amount);
  if (toDest.some((n) => !n.failed)) return null;
  const failed = toDest.find((n) => n.failed);
  if (failed) return { reason: "transfer_failed", ...failed.error ? { error: failed.error } : {}, ...failed.receipt ? { receipt: failed.receipt } : {}, ...failed.refund ? { refund: failed.refund } : {} };
  const unwrap = tx.receiptActions.find((a) => a.failed && a.executor === "wrap.near" && a.method === "near_withdraw" && str(record(a.args)["amount"]) === amount);
  const pay = tx.receiptActions.find((a) => {
    const w = record(record(a.args)["withdraw"]);
    return a.failed && a.executor === "intents.near" && a.method === "do_native_withdraw" && str(w["receiver_id"]) === dest && str(w["amount"]) === amount;
  });
  const step = unwrap ?? pay;
  return step ? { reason: "unwrap_failed", step: step.method, ...step.receipt ? { receipt: step.receipt } : {} } : null;
}
var LOCKED_DETAIL = "intents.near locked this order account (force_lock_account): a locked account cannot move its own balances, so no swap or withdrawal can run from it";
function destinationMissing(account) {
  return { kind: "destination_missing", account, detail: `no NEAR account is named ${account} yet: the token contract holds the payout under that name, and whoever creates ${account} first controls it` };
}
var ONE_CLICK = {
  settled: "SUCCESS",
  refunded: "REFUNDED",
  confidential: "PROCESSING",
  stuck: "PROCESSING",
  in_progress: "PROCESSING",
  not_found: "PENDING_DEPOSIT"
};
var DEFAULT_PARAMS = { stallAfterSec: 3600, lateAfterSec: 3600 };
var NS = 1000000000n;
var EXECUTING_AT_MOST_NS = 600n * NS;
var INT = /^-?\d+$/;
var isInt = (v) => INT.test(v);
var secondsBetween = (a, b) => Number((b - a) / NS);
function str(v) {
  return typeof v === "string" ? v : null;
}
function record(v) {
  return typeof v === "object" && v !== null ? v : {};
}
function stringMap(v) {
  const out = {};
  for (const [k, x] of Object.entries(record(v))) if (typeof x === "string") out[k] = x;
  return out;
}
function sortTxs(txs) {
  return [...txs].sort((a, b) => {
    const ha = a.height ?? Number.MAX_SAFE_INTEGER;
    const hb = b.height ?? Number.MAX_SAFE_INTEGER;
    if (ha !== hb) return ha - hb;
    return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
  });
}
var OMFT = /^([a-z]+)(?:-(?:0x)?[0-9a-zA-Z]+)?\.omft\.near$/;
var OMDEP = /^([a-z]+)(?:-[^.]+)?\.omdep\.near$/;
var OMNI_BRIDGE = "omni.bridge.near";
var POA_ON_OMNI = /* @__PURE__ */ new Set([
  "sol-57d087fd8c460f612f8701f5499ad8b2eec5ab68.omft.near",
  "sol-c58e6539c2f2e097c251f8edf11f9c03e581f8d4.omft.near",
  "sol-b9c68f94ec8fd160137af8cdfe5e61cd68e2afba.omft.near",
  "sol-bb27241c87aa401cc963c360c175dd7ca7035873.omft.near",
  "sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
  "sol-91914f13d3b54f8126a2824d71632d4b078d7403.omft.near",
  "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  "sol-df27d7abcc1c656d4ac3b1399bbfbba1994e6d8c.omft.near",
  "sol-1f00bb36e75cfc8e1274c1507cc3054f5b3f3ce1.omft.near",
  "sol-c634d063ceff771aff0c972ec396fd915a6bbd0e.omft.near",
  "sol-d600e625449a4d9380eaf5e3265e54c90d34e260.omft.near",
  "sol.omft.near",
  "aptos.omft.near",
  "aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near",
  "aptos-88cb7619440a914fe6400149a12b443c3ac21d59.omft.near",
  "starknet.omft.near",
  "zec.omft.near"
]);
var HOT_TOKEN = /^nep245:v2_1\.omni\.hot\.tg:(\d+)_([1-9A-HJ-NP-Za-km-z]*)$/;
var HOT_CHAINS = {
  "10": "op",
  "56": "bsc",
  "137": "pol",
  "143": "monad",
  "196": "xlayer",
  "1100": "stellar",
  "1111": "ton",
  "1117": "ton",
  "9745": "plasma",
  "36900": "adi",
  "43114": "avax",
  "534352": "scroll"
};
var HOT_CONTRACT = "v2_1.omni.hot.tg";
var HOT_EVM = /* @__PURE__ */ new Set(["op", "bsc", "pol", "monad", "xlayer", "plasma", "adi", "avax", "scroll"]);
var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Bytes(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 32768 ? (crc << 1 ^ 4129) & 65535 : crc << 1 & 65535;
  }
  return crc;
}
var B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value & 255) << 8 | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[value >>> bits - 5 & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + B32[value << 5 - bits & 31] : out;
}
function strKey(version, key) {
  const body = Uint8Array.from([version, ...key]);
  const crc = crc16(body);
  return base32(Uint8Array.from([...body, crc & 255, crc >> 8]));
}
function tonAddress(bytes) {
  if (bytes.length !== 34) return null;
  const n = bytes.reduce((acc, b) => acc << 8n | BigInt(b), 0n);
  if (n >> 269n !== 4n) return null;
  const workchain = Number(n >> 261n & 0xffn);
  const hash = n >> 5n & (1n << 256n) - 1n;
  const raw = Uint8Array.from([81, workchain, ...Array.from({ length: 32 }, (_, i) => Number(hash >> BigInt(8 * (31 - i)) & 0xffn))]);
  const crc = crc16(raw);
  return btoa(String.fromCharCode(...raw, crc >> 8, crc & 255)).replace(/\+/g, "-").replace(/\//g, "_");
}
function stellarAddress(bytes) {
  const word = (i) => (bytes[i] ?? 0) << 24 | (bytes[i + 1] ?? 0) << 16 | (bytes[i + 2] ?? 0) << 8 | (bytes[i + 3] ?? 0);
  if (word(0) !== 18) return null;
  if (bytes.length === 44 && word(4) === 0 && word(8) === 0) return strKey(6 << 3, bytes.slice(12));
  if (bytes.length === 40 && word(4) === 1) return strKey(2 << 3, bytes.slice(8));
  return null;
}
function hotReceiver(receiver, chain) {
  const bytes = chain === null ? null : base58Bytes(receiver);
  if (!bytes) return receiver;
  if (chain === "ton") return tonAddress(bytes) ?? receiver;
  if (chain === "stellar") return stellarAddress(bytes) ?? receiver;
  if (!HOT_EVM.has(chain ?? "")) return receiver;
  return bytes.length === 20 ? `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}` : receiver;
}
var OMNI_CHAIN = { zcash: "zec", strk: "starknet" };
var CHAIN_ALIAS = { bnb: "bsc", zcash: "zec", strk: "starknet" };
var sameChain = (a, b) => (CHAIN_ALIAS[a] ?? a) === (CHAIN_ALIAS[b] ?? b);
var POA_EVM_CHAIN = { "1": "eth", "8453": "base", "42161": "arb", "100": "gnosis", "9745": "plasma", "80094": "bera" };
function originChain(o) {
  if (o.status !== "proven") return null;
  if (o.kind === "near-native") return "near";
  if (o.kind === "hot") return o.chain;
  if (o.kind === "omni") return OMNI_CHAIN[o.chain] ?? o.chain;
  const [network, id] = o.chain.split(":");
  if (!network) return null;
  if (o.kind === "omni-utxo") return OMNI_CHAIN[network] ?? network;
  if (network === "eth") return id ? POA_EVM_CHAIN[id] ?? null : null;
  return network;
}
function tokenRoute(tokenId) {
  const hot = HOT_TOKEN.exec(tokenId);
  if (hot?.[1]) return { chain: HOT_CHAINS[hot[1]] ?? null, bridge: "hot" };
  const contract = tokenId.replace(/^nep141:/, "");
  const poa = OMFT.exec(contract);
  if (poa?.[1]) return { chain: poa[1], bridge: POA_ON_OMNI.has(contract) ? "omni" : "poa" };
  if (contract === "nbtc.bridge.near") return { chain: "btc", bridge: "omni" };
  const omni = OMDEP.exec(contract);
  if (omni?.[1]) return { chain: omni[1], bridge: "omni" };
  if (!tokenId.startsWith("nep245:") && NEAR_ACCOUNT.test(contract)) return { chain: "near", bridge: "near" };
  return { chain: null, bridge: "unknown" };
}
var NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
var isBridgeAccount = (id) => id === OMNI_BRIDGE || /(^|\.)bridge\.near$/.test(id) || /(^|\.)hot\.tg$/.test(id);
function innerMsg(d) {
  try {
    return str(record(JSON.parse(str(d["msg"]) ?? ""))["msg"]) ?? "";
  } catch {
    return "";
  }
}
function withdrawRoute(d, token) {
  const route = tokenRoute(token);
  const receiver = str(d["receiver_id"]);
  if (receiver === OMNI_BRIDGE) {
    let recipient = null;
    try {
      recipient = str(record(JSON.parse(str(d["msg"]) ?? ""))["recipient"]);
    } catch {
    }
    const short = recipient?.includes(":") ? recipient.split(":")[0] : void 0;
    if (short === "hlevm" && /"DestHexMsg"\s*:\s*"636f7265"/i.test(innerMsg(d))) return { chain: "hypercore", bridge: "omni" };
    return { chain: short ? OMNI_CHAIN[short] ?? short : route.chain, bridge: "omni" };
  }
  const contract = token.replace(/^nep141:/, "");
  if (receiver !== null && receiver === contract && OMFT.test(receiver)) return { chain: route.chain, bridge: "poa" };
  if (receiver !== null && receiver !== contract && NEAR_ACCOUNT.test(receiver) && !isBridgeAccount(receiver) && !str(d["memo"])?.startsWith("WITHDRAW_TO:")) return { chain: "near", bridge: "near" };
  return route;
}
function destinationOf(d, route) {
  if (route.bridge === "near") return { destination: str(d["receiver_id"]), externalId: null };
  const memo = str(d["memo"]);
  const poa = memo ? /^WITHDRAW_TO:([^:]+)(?::(.+))?$/.exec(memo) : null;
  if (poa?.[1]) return { destination: poa[1], externalId: poa[2] ?? null };
  const msg = str(d["msg"]);
  if (msg) {
    try {
      const m = record(JSON.parse(msg));
      const recipient = str(m["recipient"]);
      if (recipient) return { destination: recipient, externalId: str(m["external_id"]) };
      const receiver = str(m["receiver_id"]);
      if (receiver) return { destination: route.bridge === "hot" ? hotReceiver(receiver, route.chain) : receiver, externalId: null };
    } catch {
    }
  }
  return { destination: null, externalId: null };
}
function originOf(depositTx) {
  for (const e of depositTx.events) {
    if (e.failed || e.standard !== "nep141" || e.event !== "ft_transfer" || !e.executor.endsWith(".omft.near")) continue;
    for (const d of e.data) {
      const memo = str(d["memo"]);
      if (!memo?.startsWith("BRIDGED_FROM:")) continue;
      try {
        const m = record(JSON.parse(memo.slice("BRIDGED_FROM:".length)));
        const txHash = str(m["txHash"]);
        if (txHash) return { status: "proven", kind: "poa", chain: `${str(m["networkType"]) ?? "?"}:${str(m["chainId"]) ?? "?"}`, txHash, how: "BRIDGED_FROM memo on the bridge deposit" };
      } catch {
      }
    }
  }
  if (depositTx.actions.some((a) => /^(safe_)?verify_deposit/.test(a.method ?? ""))) {
    for (const e of depositTx.events) {
      const connector = /^([a-z]+)-connector\.bridge\.near$/.exec(e.executor);
      if (!connector || e.failed || e.standard !== "bridge" || e.event !== "utxo_added") continue;
      const key = e.data.flatMap((d) => Array.isArray(d["utxo_storage_keys"]) ? d["utxo_storage_keys"] : [])[0];
      const m = typeof key === "string" ? /^([0-9a-f]{64})@(\d+)$/.exec(key) : null;
      if (m?.[1] && m[2]) return { status: "proven", kind: "omni-utxo", chain: `${connector[1]}:mainnet`, txHash: m[1], vout: Number(m[2]), how: `utxo_added event of ${e.executor} on the deposit` };
    }
  }
  for (const { log, executor, failed } of depositTx.plainLogs) {
    if (failed || executor !== OMNI_BRIDGE || !log.startsWith("{")) continue;
    try {
      const t = record(record(record(JSON.parse(log))["FinTransferEvent"])["transfer_message"]);
      const sender2 = str(t["sender"]);
      const nonce = t["origin_nonce"];
      if (sender2 && nonce !== void 0) return { status: "proven", kind: "omni", chain: sender2.split(":")[0] ?? "?", originNonce: String(nonce), sender: sender2, how: "FinTransferEvent origin nonce on the Omni bridge" };
    } catch {
    }
  }
  if (depositTx.actions.some((a) => a.method === "ft_transfer_call" && str(record(a.args)["receiver_id"]) === "intents.near")) {
    return { status: "proven", kind: "near-native", chain: "near:mainnet", txHash: depositTx.hash, sender: depositTx.signer, how: "the NEAR transaction itself" };
  }
  const hot = depositTx.receiptActions.length > 0 ? depositTx.receiptActions.find((a) => !a.failed && a.executor === HOT_CONTRACT && a.method === "mt_deposit_call") : depositTx.receiver === HOT_CONTRACT ? depositTx.actions.find((a) => a.method === "mt_deposit_call") : void 0;
  if (hot) {
    const args = record(hot.args);
    const chainId = typeof args["chain_id"] === "number" ? String(args["chain_id"]) : str(args["chain_id"]);
    const nonce = typeof args["nonce"] === "number" ? String(args["nonce"]) : str(args["nonce"]);
    if (chainId && nonce) return { status: "proven", kind: "hot", chain: HOT_CHAINS[chainId] ?? chainId, originNonce: nonce, how: `mt_deposit_call on the HOT bridge, signed by HOT for chain ${chainId}` };
  }
  const onTransfer = depositTx.receiptActions.find((a) => !a.failed && a.executor === "intents.near" && a.method === "ft_on_transfer");
  const sender = onTransfer ? str(record(onTransfer.args)["sender_id"]) : null;
  if (sender && NEAR_ACCOUNT.test(sender) && !isBridgeAccount(sender) && !sender.endsWith(".omft.near")) {
    return { status: "proven", kind: "near-native", chain: "near:mainnet", txHash: depositTx.hash, sender, how: sender === depositTx.signer ? "the NEAR transaction itself" : `ft_transfer_call to intents.near, relayed by ${depositTx.signer}` };
  }
  return { status: "unverified", kind: "unknown", how: "no origin reference recognised in the deposit transaction" };
}
function addTo(balances, token, amount) {
  balances.set(token, (balances.get(token) ?? 0n) + amount);
}
function intentsEvents(tx) {
  return tx.events.filter((e) => e.executor === "intents.near" && !e.failed);
}
function mtPairs(d) {
  const tokens = Array.isArray(d["token_ids"]) ? d["token_ids"] : [];
  const amounts = Array.isArray(d["amounts"]) ? d["amounts"] : [];
  const out = [];
  tokens.forEach((t, i) => {
    const token = str(t);
    const amount = str(amounts[i]);
    if (token && amount && isInt(amount)) out.push([token, BigInt(amount)]);
  });
  return out;
}
function mtTransferNet(events, account) {
  const net = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.standard !== "nep245" || e.event !== "mt_transfer") continue;
    for (const d of e.data) {
      const from = str(d["old_owner_id"]);
      const to = str(d["new_owner_id"]);
      if (!from || !to || from === to || from !== account && to !== account) continue;
      const other = from === account ? to : from;
      const sign = to === account ? 1n : -1n;
      const tokens = net.get(other) ?? /* @__PURE__ */ new Map();
      for (const [token, amount] of mtPairs(d)) tokens.set(token, (tokens.get(token) ?? 0n) + sign * amount);
      net.set(other, tokens);
    }
  }
  return net;
}
var fullyReturned = (w) => w.returned !== void 0 && BigInt(w.returned) >= BigInt(w.amount);
var lostOnTheWay = (w) => w.refused === true || w.bounced !== void 0;
function payingWithdrawal(r) {
  const live = r.withdrawals.filter((w) => !fullyReturned(w) && !lostOnTheWay(w));
  return live.filter((w) => !w.excessRefund).at(-1) ?? live.at(-1);
}
function traceOrder(input) {
  const params = { ...DEFAULT_PARAMS, ...input.params };
  const { account, nowNs } = input;
  const txs = sortTxs(input.txs);
  const isDust = (token, amount) => {
    const below = params.dustBelow?.[token];
    return below !== void 0 && isInt(below) && isInt(amount) && BigInt(amount) < BigInt(below);
  };
  const emptyAfter = /* @__PURE__ */ new Map();
  const balances = /* @__PURE__ */ new Map();
  const deposits = [];
  const swaps = [];
  const transfers = [];
  const withdrawals = [];
  const comebacks = [];
  let depositTx = null;
  let firstCredit = null;
  let lock = null;
  for (const tx of txs) {
    const events = intentsEvents(tx);
    const diffAccounts = /* @__PURE__ */ new Set();
    for (const e of events) if (e.standard === "dip4" && e.event === "token_diff") {
      for (const d of e.data) if (str(d["account_id"])) diffAccounts.add(str(d["account_id"]));
    }
    const burns = events.filter((e) => e.standard === "nep245" && e.event === "mt_burn").flatMap((e) => e.data.filter((d) => str(d["owner_id"]) === account).flatMap(mtPairs));
    for (const [token, amount] of burns) addTo(balances, token, -amount);
    const namedByDip4 = events.some((e) => e.standard === "dip4" && e.data.some((d) => str(d["account_id"]) === account || str(d["receiver_id"]) === account));
    if (!namedByDip4) {
      for (const [other, tokens] of mtTransferNet(events, account)) {
        const out = {};
        for (const [token, v] of tokens) {
          if (v === 0n) continue;
          addTo(balances, token, v);
          if (v < 0n) {
            out[token] = (-v).toString();
            continue;
          }
          deposits.push({ status: "proven", tx: tx.hash, timestampNs: tx.timestampNs, height: tx.height, token, amount: v.toString(), via: "transfer", from: other });
          firstCredit ??= { from: other };
        }
        if (Object.keys(out).length > 0) transfers.push({ tx: tx.hash, timestampNs: tx.timestampNs, height: tx.height, to: other, toLabel: knownAccount(other)?.label ?? null, tokens: out });
      }
    }
    for (const e of events) {
      if (e.standard === "nep245" && e.event === "mt_mint") {
        for (const d of e.data) {
          const memo = str(d["memo"]);
          if (str(d["owner_id"]) !== account || memo !== "deposit" && memo !== "refund") continue;
          for (const [token, amount] of mtPairs(d)) {
            addTo(balances, token, amount);
            if (memo === "refund") {
              comebacks.push({ tx: tx.hash, token, amount });
              continue;
            }
            deposits.push({ status: "proven", tx: tx.hash, timestampNs: tx.timestampNs, height: tx.height, token, amount: amount.toString() });
            depositTx ??= tx;
            firstCredit ??= { tx };
          }
        }
        continue;
      }
      if (e.standard !== "dip4") continue;
      for (const d of e.data) {
        if (e.event === "transfer" && str(d["receiver_id"]) === account && str(d["account_id"]) !== account) {
          const from = str(d["account_id"]) ?? "?";
          for (const [token, amt] of Object.entries(stringMap(d["tokens"]))) {
            if (!isInt(amt)) continue;
            addTo(balances, token, BigInt(amt));
            deposits.push({ status: "proven", tx: tx.hash, timestampNs: tx.timestampNs, height: tx.height, token, amount: amt, via: "transfer", from });
            firstCredit ??= { from };
          }
          continue;
        }
        if (str(d["account_id"]) !== account) continue;
        if (e.event === "account_locked" || e.event === "account_unlocked") {
          lock = e.event === "account_locked" ? { tx: tx.hash, timestampNs: tx.timestampNs } : null;
          continue;
        }
        if (e.event === "token_diff") {
          const diff = stringMap(d["diff"]);
          const gave = {};
          const got = {};
          for (const [token, amt] of Object.entries(diff)) {
            if (!isInt(amt)) continue;
            const v = BigInt(amt);
            addTo(balances, token, v);
            if (v < 0n) gave[token] = (-v).toString();
            else if (v > 0n) got[token] = v.toString();
          }
          swaps.push({
            status: "proven",
            tx: tx.hash,
            timestampNs: tx.timestampNs,
            height: tx.height,
            intentHash: str(d["intent_hash"]),
            gave,
            got,
            fees: stringMap(d["fees_collected"]),
            referral: str(d["referral"]),
            counterparties: [...diffAccounts].filter((a) => a !== account)
          });
        } else if (e.event === "transfer") {
          const tokens = Object.fromEntries(Object.entries(stringMap(d["tokens"])).filter(([, a]) => isInt(a)));
          for (const [token, amt] of Object.entries(tokens)) addTo(balances, token, -BigInt(amt));
          const to = str(d["receiver_id"]) ?? "?";
          transfers.push({ tx: tx.hash, timestampNs: tx.timestampNs, height: tx.height, to, toLabel: knownAccount(to)?.label ?? null, tokens });
        } else if (e.event === "ft_withdraw" || e.event === "mt_withdraw" || e.event === "native_withdraw") {
          const pairs = [];
          if (e.event === "mt_withdraw") {
            const contract = str(d["token"]);
            const ids = Array.isArray(d["token_ids"]) ? d["token_ids"] : [];
            const amts = Array.isArray(d["amounts"]) ? d["amounts"] : [];
            ids.forEach((t, i) => {
              const id = str(t);
              const amount = str(amts[i]);
              if (contract && id && amount && isInt(amount)) pairs.push([`nep245:${contract}:${id}`, amount]);
            });
          } else {
            const contract = e.event === "native_withdraw" ? "wrap.near" : str(d["token"]);
            const amount = str(d["amount"]);
            if (contract && amount && isInt(amount)) pairs.push([contract.startsWith("nep141:") ? contract : `nep141:${contract}`, amount]);
          }
          if (burns.length === 0) {
            for (const [token, amount] of pairs) addTo(balances, token, -BigInt(amount));
            const storage = str(d["storage_deposit"]);
            if (storage && isInt(storage)) addTo(balances, "nep141:wrap.near", -BigInt(storage));
          }
          let feeLeg = null;
          try {
            feeLeg = str(record(JSON.parse(str(d["msg"]) ?? ""))["amount_native"]);
          } catch {
          }
          const hotChain = (t) => HOT_TOKEN.exec(t)?.[1];
          const firstChain = pairs[0] ? hotChain(pairs[0][0]) : void 0;
          const hops = pairs.length > 1 && feeLeg && firstChain ? pairs.filter(([t, a], i) => !(i > 0 && a === feeLeg && hotChain(t) === firstChain)) : pairs;
          const tokenContract = e.event === "native_withdraw" ? null : str(d["token"])?.replace(/^nep141:/, "");
          const callFailed = tokenContract !== null && tokenContract !== void 0 && tx.receiptActions.some((a) => a.failed === true && a.executor === tokenContract && /_transfer_call$/.test(a.method));
          const bounce = e.event === "native_withdraw" ? nativeBounce(tx, str(d["receiver_id"]), str(d["amount"])) : null;
          for (const [token, amount] of hops) {
            const route = withdrawRoute(d, token);
            const dest = destinationOf(d, route);
            withdrawals.push({
              status: "proven",
              tx: tx.hash,
              timestampNs: tx.timestampNs,
              height: tx.height,
              intentHash: str(d["intent_hash"]),
              kind: e.event,
              token,
              amount,
              chain: route.chain,
              bridge: route.bridge,
              destination: dest.destination,
              externalId: dest.externalId,
              ...callFailed ? { refused: true } : {},
              ...bounce ? { bounced: bounce } : {}
            });
          }
        }
      }
    }
    emptyAfter.set(tx.hash, [...balances].every(([t, v]) => v <= 0n || isDust(t, v.toString())));
  }
  const ownKey = input.txs.some((t) => t.signer === account);
  const OWN_KEY = { kind: "own_key", detail: "this account signs its own transactions, so its owner holds its key: it is not a 1Click order account" };
  if (!input.oneOrder) {
    const worthSomething = (token, amount) => params.dustBelow?.[token] !== void 0 && !isDust(token, amount);
    const parts = splitOrders(txs, emptyAfter, deposits, transfers, withdrawals, worthSomething);
    if (parts.length > 1) {
      const focused = input.focusTx ? parts.findIndex((p) => p.some((t) => t.hash === input.focusTx)) : -1;
      const index = focused >= 0 ? focused : parts.length - 1;
      const report = traceOrder({ ...input, txs: parts[index] ?? [], oneOrder: true });
      report.flags.unshift({
        kind: "several_orders",
        count: parts.length,
        shown: index + 1,
        detail: `this account received ${parts.length} separate deposits, each finished before the next arrived; this report follows ${focused >= 0 ? "the one with the transaction you gave" : "the latest"} (${index + 1} of ${parts.length}). Paste another one's NEAR transaction to see it.`
      });
      if (ownKey && !report.flags.some((f) => f.kind === "own_key")) report.flags.push(OWN_KEY);
      return report;
    }
  }
  const remaining = {};
  let sawNegative = false;
  for (const [token, v] of [...balances.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (v < 0n) sawNegative = true;
    else if (v > 0n) remaining[token] = v.toString();
  }
  for (const c of comebacks) {
    let left = c.amount;
    for (const w of withdrawals) {
      if (left === 0n || w.tx !== c.tx || w.token !== c.token) continue;
      const already = BigInt(w.returned ?? "0");
      const take = left < BigInt(w.amount) - already ? left : BigInt(w.amount) - already;
      if (take <= 0n) continue;
      w.returned = (already + take).toString();
      left -= take;
    }
  }
  for (const w of withdrawals) if (w.refused && w.returned !== void 0) delete w.refused;
  if (swaps.length > 0) {
    const got = new Set(swaps.flatMap((s) => Object.keys(s.got)));
    const minted = new Set(deposits.filter((d) => d.via !== "transfer").map((d) => d.token));
    if (withdrawals.some((w) => got.has(w.token))) {
      for (const w of withdrawals) if (!got.has(w.token) && minted.has(w.token)) w.excessRefund = true;
    }
  }
  const paying = withdrawals.filter((w) => !fullyReturned(w) && !lostOnTheWay(w));
  const lost = withdrawals.some(lostOnTheWay);
  const flags = [];
  let executing;
  for (const t of txs) {
    const n = t.pendingReceipts?.length ?? 0;
    if (n === 0) continue;
    if (t.timestampNs === null || nowNs - t.timestampNs < EXECUTING_AT_MOST_NS) {
      executing ??= t;
      if (executing === t) flags.push({ kind: "executing", tx: t.hash, detail: `NEAR is still executing transaction ${t.hash} (${n} of its steps ${n === 1 ? "has" : "have"} not run yet): this is not final, check again in a minute` });
    } else flags.push({ kind: "incomplete_history", detail: `transaction ${t.hash} is missing ${n} of its steps in the data we read, long after it ran: part of it is not traced` });
  }
  const firstDeposit = deposits[0];
  const firstSwap = swaps[0];
  const lastWithdrawal = payingWithdrawal({ withdrawals: paying });
  const intents = [...swaps, ...transfers, ...withdrawals];
  const unshielded = deposits.some((d) => d.via === "transfer" && d.from !== void 0 && knownAccount(d.from)?.kind === "confidential");
  const depositTokens = new Set(deposits.filter((d) => !(d.via === "transfer" && d.from !== void 0 && knownAccount(d.from)?.kind === "confidential")).map((d) => d.token));
  const origin = firstCredit !== null && "from" in firstCredit ? {
    status: "unverified",
    kind: "unknown",
    how: knownAccount(firstCredit.from)?.kind === "confidential" ? "unshielded from the Confidential Intents treasury: the private leg before it is not public" : `funded by a transfer inside NEAR Intents from ${firstCredit.from}`
  } : depositTx ? originOf(depositTx) : { status: "missing" };
  const fromChain = originChain(origin);
  const backToOrigin = (w) => fromChain === null || w.chain === null || sameChain(w.chain, fromChain);
  const isRefund = swaps.length === 0 && paying.some((w) => depositTokens.has(w.token) && backToOrigin(w));
  if (firstDeposit && firstSwap && firstDeposit.timestampNs !== null && firstSwap.timestampNs !== null) {
    const delaySec = secondsBetween(firstDeposit.timestampNs, firstSwap.timestampNs);
    if (delaySec > params.lateAfterSec) flags.push({ kind: "settled_late", delaySec, detail: `${describeDuration(delaySec)} from credit to the first intent` });
  }
  if (isRefund) flags.push({ kind: "refunded", detail: "the deposited token was withdrawn without a swap" });
  if (withdrawals.some((w) => w.returned !== void 0)) flags.push({ kind: "withdrawal_returned", detail: "a withdrawal failed and its tokens came back to the order account" });
  if (withdrawals.some((w) => w.refused)) flags.push({ kind: "withdrawal_refused", detail: "the transfer to the bridge failed, and NEAR Intents does not credit a failed ft_transfer_call back: the tokens stay with intents.near, outside the order account" });
  const bounced = withdrawals.find((w) => w.bounced);
  if (bounced?.bounced) flags.push({ kind: "payout_bounced", detail: bounceDetail(bounced, bounced.bounced) });
  const shieldHeights = [
    ...transfers.filter((t) => knownAccount(t.to)?.kind === "confidential").map((t) => t.height ?? -1),
    ...withdrawals.filter((w) => w.destination !== null && knownAccount(w.destination)?.kind === "confidential").map((w) => w.height ?? -1)
  ];
  const toConfidential = shieldHeights.length > 0;
  const roundTrip = toConfidential && lastWithdrawal !== void 0 && (lastWithdrawal.height ?? -1) > Math.max(...shieldHeights);
  if (roundTrip) flags.push({ kind: "confidential", detail: "part of the order went through Confidential Intents and came back; the withdrawal after it is public" });
  else if (toConfidential) flags.push({ kind: "confidential", detail: "funds moved into Confidential Intents; later legs are not visible on public NEAR" });
  else if (unshielded) flags.push({ kind: "confidential", detail: "funded from Confidential Intents; the legs before it are not visible on public NEAR" });
  const outflowHeights = [...swaps, ...transfers, ...withdrawals].map((h) => h.height ?? -1);
  const lastOutflow = outflowHeights.length ? Math.max(...outflowHeights) : null;
  const later = /* @__PURE__ */ new Map();
  if (lastOutflow !== null) {
    for (const d of deposits) if ((d.height ?? -1) > lastOutflow) later.set(d.token, (later.get(d.token) ?? 0n) + BigInt(d.amount));
  }
  const leftover = Object.entries(remaining);
  const dustLeft = leftover.filter(([t, a]) => isDust(t, a));
  const laterLeft = leftover.filter(([t, a]) => later.get(t) === BigInt(a) && !isDust(t, a));
  const leftoverExplained = lastOutflow !== null && leftover.length > 0 && laterLeft.length + dustLeft.length === leftover.length;
  if (leftoverExplained && laterLeft.length > 0) flags.push({ kind: "later_deposit", detail: "the amount still in the account arrived after the order finished; it is a separate deposit, not part of this order" });
  if (leftoverExplained && dustLeft.length > 0) flags.push({ kind: "dust", detail: "what is left in the order account is worth less than 5 US cents at current prices: dust, not stuck money" });
  if (sawNegative) flags.push({ kind: "incomplete_history", detail: "more left the account than we saw arrive; part of its history is missing" });
  const emptied = leftover.length === 0 || leftoverExplained;
  const intentsPayout = paying.length === 0 && emptied && !lost ? transferPayout(swaps, deposits, transfers) : null;
  let verdict;
  if (executing) verdict = "in_progress";
  else if (deposits.length === 0) verdict = "not_found";
  else if (emptied && toConfidential && !roundTrip) verdict = "confidential";
  else if (emptied && paying.length > 0) verdict = isRefund ? "refunded" : "settled";
  else if (intentsPayout) verdict = swaps.length === 0 ? "refunded" : "settled";
  else if (lost && emptied) verdict = "stuck";
  else if (lock) verdict = "stuck";
  else {
    const lastTs = [...deposits, ...intents].reduce((m, h) => h.timestampNs !== null && (m === null || h.timestampNs > m) ? h.timestampNs : m, null);
    const waitedSec = lastTs === null ? 0 : secondsBetween(lastTs, nowNs);
    if (waitedSec > params.stallAfterSec) {
      flags.push({ kind: "stalled", waitedSec, detail: intents.length === 0 ? "credited, no intent since" : "funds still in the order account after the last intent" });
      verdict = "stuck";
    } else verdict = "in_progress";
  }
  let payout = lastWithdrawal ? nearPayout(lastWithdrawal, txs) : intentsPayout ?? { status: "missing" };
  if (lastWithdrawal && executing?.hash === lastWithdrawal.tx && payout.status !== "arrived") {
    payout = { status: "waiting", chain: lastWithdrawal.chain, bridge: lastWithdrawal.bridge, destination: lastWithdrawal.destination, waitedSec: lastWithdrawal.timestampNs === null ? 0 : secondsBetween(lastWithdrawal.timestampNs, nowNs) };
  }
  if (lock) flags.push({ kind: "locked", tx: lock.tx, waitedSec: lock.timestampNs === null ? 0 : secondsBetween(lock.timestampNs, nowNs), detail: LOCKED_DETAIL });
  if (ownKey) flags.push(OWN_KEY);
  return {
    account,
    verdict,
    oneClickStatus: ONE_CLICK[verdict],
    origin,
    deposits,
    swaps,
    transfers,
    withdrawals,
    payout,
    balances: remaining,
    flags
  };
}
function splitOrders(txs, emptyAfter, deposits, transfers, withdrawals, worthSomething) {
  const parts = [];
  let open = null;
  for (const tx of txs) {
    const credits = deposits.filter((d) => d.tx === tx.hash);
    if (open === null) {
      const last = parts.at(-1);
      const returnLeg = last !== void 0 && credits.length > 0 && credits.every((d) => d.from !== void 0 && last.sentTo.has(d.from));
      const worthAnOrder = credits.some((d) => worthSomething(d.token, d.amount));
      if (last && (!worthAnOrder || returnLeg)) open = parts.pop() ?? null;
      open ??= { txs: [], sentTo: /* @__PURE__ */ new Set(), credited: false, paidOut: false };
    }
    open.txs.push(tx);
    if (credits.length > 0) open.credited = true;
    for (const t of transfers) if (t.tx === tx.hash) open.sentTo.add(t.to);
    if (transfers.some((t) => t.tx === tx.hash) || withdrawals.some((w) => w.tx === tx.hash)) open.paidOut = true;
    if (open.credited && open.paidOut && emptyAfter.get(tx.hash) === true) {
      parts.push(open);
      open = null;
    }
  }
  if (open) parts.push(open);
  return parts.filter((p) => p.credited).length > 1 ? parts.map((p) => p.txs) : [txs];
}
function transferPayout(swaps, deposits, transfers) {
  const wanted = new Set(swaps.length ? swaps.flatMap((s) => Object.keys(s.got)) : deposits.map((d) => d.token));
  let best = null;
  for (const t of transfers) {
    if (t.toLabel !== null) continue;
    for (const [token, amt] of Object.entries(t.tokens)) {
      if (!wanted.has(token)) continue;
      const amount = BigInt(amt);
      if (!best || amount > best.amount) best = { t, token, amount };
    }
  }
  if (!best) return null;
  return { status: "arrived", how: "proven", chain: "near", bridge: "near", destination: best.t.to, tx: best.t.tx, amount: best.amount.toString(), delaySec: 0, confirmed: true, via: "transfer" };
}
function nearPayout(w, txs) {
  const base = { chain: w.chain, bridge: w.bridge, destination: w.destination };
  if (w.bridge !== "near" || !w.destination) return { status: "unverified", ...base };
  const tx = txs.find((t) => t.hash === w.tx);
  if (w.kind === "native_withdraw") {
    const sent = tx?.nativeTransfers?.some((n) => !n.failed && n.from === "intents.near" && n.to === w.destination && n.deposit === w.amount);
    if (sent) return { status: "arrived", how: "proven", ...base, tx: w.tx, amount: w.amount, delaySec: 0, confirmed: true };
    return { status: "unverified", ...base, reason: tx?.nativeTransfers ? "no successful transfer of the withdrawn NEAR to the destination in the withdrawal transaction" : "native NEAR is paid by a plain transfer that logs no event; check the receiver on the explorer" };
  }
  const contract = w.token.replace(/^nep141:/, "");
  const paid = tx?.events.find(
    (e) => !e.failed && e.standard === "nep141" && e.event === "ft_transfer" && e.executor === contract && e.data.some((d) => str(d["new_owner_id"]) === w.destination && str(d["amount"]) === w.amount)
  );
  const wrapped = contract === "wrap.near" && tx?.plainLogs.some((l) => !l.failed && l.executor === "wrap.near" && l.log === `Transfer ${w.amount} from intents.near to ${w.destination}`);
  if (!paid && !wrapped) return { status: "unverified", ...base, reason: "no successful transfer to the destination in the withdrawal transaction" };
  return { status: "arrived", how: "proven", ...base, tx: w.tx, amount: w.amount, delaySec: 0, confirmed: true };
}
function describeDuration(sec) {
  if (sec < 90) return `${sec} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} days`;
}
var ORDER_ID = /^(?:[0-9a-f]{64}|0x[0-9a-f]{40}|0s[0-9a-f]{40}|0u[0-9a-hjkmnp-tv-z]{51}[0g])$/;
function findOrderAccount(tx) {
  const all = tx.events.filter((e) => e.executor === "intents.near");
  return orderAccountIn(all.filter((e) => !e.failed)) ?? orderAccountIn(all);
}
function orderAccountIn(intents) {
  const diffs = intents.filter((e) => e.standard === "dip4" && e.event === "token_diff").flatMap((e) => e.data);
  const withReferral = diffs.find((d) => str(d["referral"]) && str(d["account_id"]));
  if (withReferral) return str(withReferral["account_id"]);
  for (const e of intents) if (e.standard === "nep245" && e.event === "mt_mint") {
    for (const d of e.data) if (str(d["memo"]) === "deposit" && str(d["owner_id"])) return str(d["owner_id"]);
  }
  for (const e of intents) if (e.standard === "dip4" && /_withdraw$/.test(e.event)) {
    for (const d of e.data) if (str(d["account_id"])) return str(d["account_id"]);
  }
  const implicit = diffs.map((d) => str(d["account_id"])).find((a) => a && ORDER_ID.test(a));
  if (implicit) return implicit;
  if (diffs[0]) return str(diffs[0]["account_id"]);
  const funded = [];
  for (const e of intents) {
    for (const d of e.data) {
      const move = e.standard === "dip4" && e.event === "transfer" ? [str(d["account_id"]), str(d["receiver_id"])] : e.standard === "nep245" && e.event === "mt_transfer" ? [str(d["old_owner_id"]), str(d["new_owner_id"])] : null;
      const [from, to] = move ?? [];
      if (from && to) funded.push(knownAccount(to) ? from : to);
    }
  }
  return funded.find((a) => ORDER_ID.test(a)) ?? funded[0] ?? null;
}

// apps/wheres-my-swap/src/core/payout.ts
var EVM_CHAINS = ["eth", "base", "arb", "op", "gnosis", "bsc", "pol", "avax", "monad", "xlayer", "plasma", "scroll", "adi", "hood", "bera", "abs", "hlevm", "hypercore"];
var UTXO_PAYOUT_CHAINS = ["ltc", "doge", "bch", "dash"];
var OTHER_PAYOUT_CHAINS = ["xrp", "sui", "ton", "stellar", "cardano", "aptos", "starknet"];
var EVM = new Set(EVM_CHAINS);
var SUPPORTED = /* @__PURE__ */ new Set([...EVM, ...UTXO_PAYOUT_CHAINS, ...OTHER_PAYOUT_CHAINS, "tron", "btc", "sol"]);
function expectedWithinSec(chain) {
  return chain === "btc" ? 3600 : 1800;
}
var SEARCH_AFTER_SEC = 86400;
var SKEW_SEC = 60;
var EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
var TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
var BTC_ADDRESS = /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;
var SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
var ADDRESS = {
  ltc: /^(ltc1q[02-9ac-hj-np-z]{38}|ltc1[qp][02-9ac-hj-np-z]{58}|[LM3][1-9A-HJ-NP-Za-km-z]{33})$/,
  doge: /^[DA9][1-9A-HJ-NP-Za-km-z]{33}$/,
  bch: /^[qp][02-9ac-hj-np-z]{41}$/,
  dash: /^[X7][1-9A-HJ-NP-Za-km-z]{33}$/,
  xrp: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  sui: /^0x[0-9a-f]{64}$/,
  aptos: /^0x[0-9a-f]{64}$/,
  starknet: /^0x[0-9a-f]{64}$/,
  ton: /^(?:[EU]Q[A-Za-z0-9_-]{46}|0:[0-9A-F]{64})$/,
  stellar: /^G[A-D][A-Z2-7]{54}$/,
  cardano: /^addr1(?:[02-9ac-hj-np-z]{53}|[02-9ac-hj-np-z]{98})$/
};
function addressOk(chain, a) {
  if (EVM.has(chain)) return EVM_ADDRESS.test(a);
  if (chain === "tron") return TRON_ADDRESS.test(a);
  if (chain === "btc") return BTC_ADDRESS.test(a);
  const re = ADDRESS[chain];
  return re ? re.test(a) : SOL_ADDRESS.test(a);
}
function normalized(chain, a) {
  if (chain === "bch") return a.toLowerCase().replace(/^bitcoincash:/, "");
  if (chain === "ltc" && /^ltc1/i.test(a)) return a.toLowerCase();
  if ((chain === "sui" || chain === "aptos" || chain === "starknet") && /^0x[0-9a-fA-F]{1,64}$/.test(a)) return hex64(a);
  if (chain === "ton" && /^0:[0-9a-fA-F]{64}$/.test(a)) return a.toUpperCase();
  return a;
}
var hex64 = (a) => `0x${a.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
function tonRaw(a) {
  const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(a);
  if (raw) return `${Number(raw[1])}:${(raw[2] ?? "").toUpperCase()}`;
  if (!/^[A-Za-z0-9_-]{48}$/.test(a)) return null;
  let bin;
  try {
    bin = atob(a.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  if (bin.length !== 36) return null;
  const wc = bin.charCodeAt(1) > 127 ? bin.charCodeAt(1) - 256 : bin.charCodeAt(1);
  let hex = "";
  for (let i = 2; i < 34; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return `${wc}:${hex.toUpperCase()}`;
}
var HOT_STELLAR = {
  "v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz": { kind: "native" },
  "v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu": { kind: "token", contract: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" }
};
var HYPEREVM_TOKENS = {
  "wrap.near": { contract: "0xc80d9eb120d6e40e31d5ae9040d5fc0753c52da7", scale: 10n ** 6n }
  // ONEAR, 18 decimals
};
var B582 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Bytes2(s) {
  let n = 0n;
  for (const c of s) {
    const i = B582.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const hex = n === 0n ? "" : n.toString(16);
  const body = (hex.length % 2 ? "0" : "") + hex;
  const zeros = s.length - s.replace(/^1+/, "").length;
  const out = new Uint8Array(zeros + body.length / 2);
  for (let i = 0; i < body.length / 2; i++) out[zeros + i] = parseInt(body.slice(2 * i, 2 * i + 2), 16);
  return out;
}
function hotAsset(id) {
  const m = /^v2_1\.omni\.hot\.tg:\d+_([1-9A-HJ-NP-Za-km-z]*)$/.exec(id);
  const bytes = m?.[1] ? base58Bytes2(m[1]) : null;
  if (!bytes || bytes.length !== 20) return null;
  if (bytes.every((b) => b === 0)) return { kind: "native" };
  return { kind: "token", contract: `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` };
}
function assetOf(chain, contract) {
  if (contract === "nbtc.bridge.near" || new RegExp(`^${chain}\\.(omft|omdep)\\.near$`).test(contract)) return { kind: "native" };
  if (contract.startsWith("v2_1.omni.hot.tg:")) {
    if (EVM.has(chain)) return hotAsset(contract);
    if (chain === "ton") return /^v2_1\.omni\.hot\.tg:\d+_$/.test(contract) ? { kind: "native" } : null;
    if (chain === "stellar") return HOT_STELLAR[contract] ?? null;
    return null;
  }
  const hyper = chain === "hlevm" || chain === "hypercore" ? HYPEREVM_TOKENS[contract] : void 0;
  if (hyper) return { kind: "token", contract: hyper.contract };
  const erc20 = /^[a-z]+-(0x[0-9a-fA-F]{40})\.omft\.near$/.exec(contract);
  if (erc20?.[1] && EVM.has(chain)) return { kind: "token", contract: erc20[1].toLowerCase() };
  const trc20 = /^tron-([0-9a-f]{40})\.omft\.near$/.exec(contract);
  if (trc20?.[1]) return { kind: "token", contract: trc20[1] };
  if (chain === "sol") return { kind: "any" };
  return null;
}
function payoutTarget(w) {
  const routed = w.chain ?? tokenRoute(w.token).chain;
  if (!routed || !SUPPORTED.has(routed)) return { unsupported: `payouts on ${routed ?? "this chain"} are not searched yet` };
  const chain = routed;
  if (!w.destination) return { unsupported: "the withdrawal names no destination" };
  const address = normalized(chain, w.destination.replace(/^[a-z]+:/i, ""));
  if (!addressOk(chain, address)) return { unsupported: `the destination is not a valid ${chainName(chain)} address` };
  const bare = w.token.replace(/^nep(141|245):/, "");
  const asset = assetOf(chain, bare);
  if (!asset) return { unsupported: `the token ${bare} is not recognised on ${chain}` };
  if (w.timestampNs === null) return { unsupported: "the withdrawal has no block time" };
  const target = { chain, address, asset, burned: BigInt(w.amount), burnSec: Number(w.timestampNs / 1000000000n) };
  const hyper = chain === "hlevm" || chain === "hypercore" ? HYPEREVM_TOKENS[bare] : void 0;
  if (hyper) return { ...target, scale: hyper.scale };
  return chain === "xrp" && w.externalId ? { ...target, tag: w.externalId } : target;
}
var EVM_TREASURY = {
  "0x2cff890f0378a11913b6129b2e97417a2c302680": "NEAR Intents",
  "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd": "HOT Bridge"
};
var TREASURY = {
  tron: { TX5XiRXdyz7sdFwF5mnhT1QoGCpbkncpke: "NEAR Intents", "41e78cc21a0dfb6e840d52652224493b60d02ed628": "NEAR Intents" },
  btc: { "1C6XJtNXiuXvk4oUAVMkKF57CRpaTrN5Ra": "NEAR Intents" },
  sol: { HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16: "NEAR Intents", "8sXzdKW2jFj7V5heRwPMcygzNH3JZnmie5ZRuNoTuKQC": "HOT Bridge" },
  // Read 2026-10-17; every PoA payout seen on these chains (2024-2026) came from these wallets. BCH is listed in legacy
  // form (1LxByj…), the same key as the CashAddr its payouts show.
  ltc: { LQjEMkuiA2pCwFeUPwsu6ktzUubBVLsahX: "NEAR Intents" },
  doge: { DRmCnxzL9U11EJzLmWkm2ikaZikPFbLuQD: "NEAR Intents" },
  bch: { qrdd5m5s72wzs4u373ux2fcpn02hw00u7v9wr8cex8: "NEAR Intents", "1LxByjYMdnogW9Nc73srT4NCbS8oPVaXvZ": "NEAR Intents" },
  dash: { XxA9DbXaFpF4GFY8KUNX7eAxhZPsWtcKhc: "NEAR Intents" },
  xrp: { r9R8jciZBYGq32DxxQrBPi5ysZm67iQitH: "NEAR Intents" },
  sui: { "0x00ea18889868519abd2f238966cab9875750bb2859ed3a34debec37781520138": "NEAR Intents" },
  aptos: { "0xd1a1c1804e91ba85a569c7f018bb7502d2f13d4742d2611953c9c14681af6446": "NEAR Intents" },
  starknet: { "0x03b79b882cd0310822ebf3fe2be44a828f8939e699f8fd55a69cd70473f69090": "NEAR Intents" },
  cardano: { addr1v8wfpcg4qfhmnzprzysj6j9c53u5j56j8rvhyjp08s53s6g07rfjm: "NEAR Intents" },
  // TON in raw form (the list writes UQAfoBd…_trZ and EQANEViM…CNVJ).
  ton: { "0:1FA0177F7F4A48BCDA543C090E82E52B156A46595F53581799B3FE535C4F79FE": "NEAR Intents", "0:0D11588CDC0290CE2E808F7B047B2A85BBCA57AA1CBD43DC46A0877FD2AA7708": "HOT Bridge" },
  stellar: { GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK: "NEAR Intents", CCLWL5NYSV2WJQ3VBU44AMDHEVKEPA45N2QP2LL62O3JVKPGWWAQUVAG: "HOT Bridge" }
};
function treasuryOf(chain, address) {
  if (!address) return null;
  if (EVM.has(chain)) return EVM_TREASURY[address.toLowerCase()] ?? null;
  return TREASURY[chain]?.[address] ?? null;
}
function maxFee(t, decimals) {
  const half = t.burned / 200n;
  if (t.chain === "btc") return 5400n;
  if (t.chain === "tron") return t.asset.kind === "native" ? 5000000n : 2500000n;
  if (t.chain === "sol") return half;
  if (t.asset.kind === "native") return 10n ** 16n;
  const tenTokens = 10n * 10n ** BigInt(decimals ?? 6);
  return tenTokens > half ? tenTokens : half;
}
function matchPayout(t, page, nowSec, base, report) {
  const b = report ? { ...base, bridgeReport: report } : base;
  const fits = (x) => {
    if (!/^\d+$/.test(x.amount)) return false;
    if (x.timestampSec !== null && (x.timestampSec < t.burnSec - SKEW_SEC || x.timestampSec > t.burnSec + SEARCH_AFTER_SEC)) return false;
    const amount = BigInt(x.amount);
    return amount > 0n && amount <= t.burned && amount >= t.burned - maxFee(t, x.decimals);
  };
  const arrived = (x, how) => ({
    status: "arrived",
    how,
    ...b,
    tx: x.tx,
    amount: x.amount,
    delaySec: x.timestampSec === null ? null : x.timestampSec - t.burnSec,
    confirmed: x.timestampSec !== null,
    sender: x.from ? { address: x.from, treasury: treasuryOf(t.chain, x.from) } : null
  });
  const find = (tx) => tx ? page.items.find((x) => x.tx.toLowerCase() === tx.toLowerCase() && /^\d+$/.test(x.amount)) : void 0;
  const named = find(report?.fastTx) ?? find(report?.tx);
  if (named) return arrived(named, "confirmed");
  let cands = page.items.filter(fits);
  if (base.bridge === "poa" && cands.length > 1) {
    const fromTreasury = cands.filter((x) => treasuryOf(t.chain, x.from) !== null);
    if (fromTreasury.length > 0) cands = fromTreasury;
  }
  const waitedSec = Math.max(0, nowSec - t.burnSec);
  const only = cands[0];
  if (cands.length === 1 && only) return arrived(only, "matched");
  if (cands.length > 1) return { status: "ambiguous", ...b, txs: cands.map((c) => c.tx) };
  if (waitedSec < expectedWithinSec(t.chain)) return { status: "waiting", ...b, waitedSec };
  if (!page.complete) return { status: "unverified", ...b, reason: page.unsearched ?? "the destination has too many later transactions to search back to this withdrawal" };
  return { status: "not_found", ...b, waitedSec };
}

// apps/wheres-my-swap/src/core/views.ts
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function viewAccount(account) {
  return { jsonrpc: "2.0", id: "wms", method: "query", params: { request_type: "view_account", finality: "final", account_id: account } };
}
function accountExistsFrom(answer) {
  if (!isObj(answer)) return null;
  const result = answer["result"];
  if (isObj(result)) {
    const legacy = result["error"];
    if (legacy === void 0) return true;
    return typeof legacy === "string" && /does not exist while viewing/.test(legacy) ? false : null;
  }
  const err = answer["error"];
  return isObj(err) && isObj(err["cause"]) && err["cause"]["name"] === "UNKNOWN_ACCOUNT" ? false : null;
}
var NAMED = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
var KEYED = /^(?:[0-9a-f]{64}|0x[0-9a-f]{40}|0s[0-9a-f]{40}|0u[0-9a-hjkmnp-tv-z]{51}[0g])$/;
var claimableName = (id) => NAMED.test(id) && !KEYED.test(id);
function base64Json(v) {
  let s = "";
  for (const b of new TextEncoder().encode(JSON.stringify(v))) s += String.fromCharCode(b);
  return btoa(s);
}
function intentsView(method, args, blockId) {
  const at = blockId === void 0 ? { finality: "final" } : { block_id: blockId };
  return { jsonrpc: "2.0", id: "wms", method: "query", params: { request_type: "call_function", ...at, account_id: "intents.near", method_name: method, args_base64: base64Json(args) } };
}
function viewResult(answer) {
  if (!isObj(answer) || !isObj(answer["result"])) return null;
  const r = answer["result"];
  const bytes = r["result"];
  const height = r["block_height"];
  const hash = r["block_hash"];
  if (!Array.isArray(bytes) || typeof height !== "number" || typeof hash !== "string") return null;
  if (!bytes.every((b) => typeof b === "number" && Number.isInteger(b) && b >= 0 && b < 256)) return null;
  try {
    return { value: JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))), blockHeight: height, blockHash: hash };
  } catch {
    return null;
  }
}
function tokenIdsFrom(value) {
  if (!Array.isArray(value)) return null;
  const ids = value.map((t) => isObj(t) && typeof t["token_id"] === "string" ? t["token_id"] : null);
  return ids.every((id) => id !== null) ? ids : null;
}
function balancesFrom(tokenIds, value) {
  if (!Array.isArray(value) || value.length !== tokenIds.length) return null;
  const out = {};
  for (const [i, amount] of value.entries()) {
    const token = tokenIds[i];
    if (token === void 0 || typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
    if (BigInt(amount) > 0n) out[token] = amount;
  }
  return out;
}
function compareBalances(ledger, chain) {
  const tokens = [.../* @__PURE__ */ new Set([...Object.keys(ledger), ...Object.keys(chain)])].sort();
  return tokens.flatMap((token) => {
    const l = ledger[token] ?? "0";
    const c = chain[token] ?? "0";
    return BigInt(l) === BigInt(c) ? [] : [{ token, ledger: l, chain: c }];
  });
}
var groupDigits = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function balanceCheck(ledger, chain) {
  if (!chain) return { check: { status: "not_verified", reason: "intents.near's balances could not be read now" } };
  const at = { blockHeight: chain.blockHeight, blockHash: chain.blockHash };
  const differences = compareBalances(ledger, chain.balances);
  if (differences.length === 0) return { check: { status: "verified", ...at } };
  const list = (side) => differences.map((d) => `${d[side]} ${d.token}`).join(", ");
  return {
    check: { status: "differs", ...at, differences },
    flag: { kind: "ledger_mismatch", detail: `intents.near holds ${list("chain")} for this account at block ${groupDigits(chain.blockHeight)}, where the history we read adds up to ${list("ledger")}: part of the history may be missing, or the account moved after it was read` }
  };
}

// apps/wheres-my-swap/src/core/zcash-address.ts
var MASK64 = (1n << 64n) - 1n;
var K256 = Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
function sha256(msg) {
  const len = msg.length;
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  padded.set(msg);
  padded[len] = 128;
  const bitLen = BigInt(len) * 8n;
  for (let i = 0; i < 8; i++) padded[padded.length - 1 - i] = Number(bitLen >> BigInt(8 * i) & 0xffn);
  const h = Uint32Array.from([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => x >>> n | x << 32 - n;
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (padded[off + 4 * i] ?? 0) << 24 | (padded[off + 4 * i + 1] ?? 0) << 16 | (padded[off + 4 * i + 2] ?? 0) << 8 | (padded[off + 4 * i + 3] ?? 0);
    for (let i = 16; i < 64; i++) {
      const a2 = w[i - 15] ?? 0;
      const b2 = w[i - 2] ?? 0;
      const s0 = rotr(a2, 7) ^ rotr(a2, 18) ^ a2 >>> 3;
      const s1 = rotr(b2, 17) ^ rotr(b2, 19) ^ b2 >>> 10;
      w[i] = (w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1 >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0];
    for (let i = 0; i < 64; i++) {
      const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + (e & f ^ ~e & g) + (K256[i] ?? 0) + (w[i] ?? 0) >>> 0;
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) >>> 0;
      [hh, g, f, e, d, c, b, a] = [g, f, e, d + t1 >>> 0, c, b, a, t1 + t2 >>> 0];
    }
    [a, b, c, d, e, f, g, hh].forEach((x, i) => {
      h[i] = (h[i] ?? 0) + x >>> 0;
    });
  }
  const out = new Uint8Array(32);
  h.forEach((x, i) => {
    out[4 * i] = x >>> 24;
    out[4 * i + 1] = x >>> 16 & 255;
    out[4 * i + 2] = x >>> 8 & 255;
    out[4 * i + 3] = x & 255;
  });
  return out;
}
var PERSONAL_H = new TextEncoder().encode("UA_F4Jumble_H");
var PERSONAL_G = new TextEncoder().encode("UA_F4Jumble_G");
var CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
var BECH32_CONST = 1;
var BECH32M_CONST = 734539939;
function polymod(values) {
  const G = [996825010, 642813549, 513874426, 1027748829, 705979059];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = (chk & 33554431) << 5 ^ v;
    for (let i = 0; i < 5; i++) if (top >>> i & 1) chk ^= G[i] ?? 0;
  }
  return chk >>> 0;
}
function bech32Decode(s) {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return { error: "mixed case" };
  const str5 = s.toLowerCase();
  const sep = str5.lastIndexOf("1");
  if (sep < 1 || sep + 7 > str5.length) return { error: "not Bech32" };
  const hrp = str5.slice(0, sep);
  const words = [];
  for (const ch of str5.slice(sep + 1)) {
    const w = CHARSET.indexOf(ch);
    if (w === -1) return { error: "not Bech32" };
    words.push(w);
  }
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const check = polymod([...expand, ...words]);
  const variant = check === BECH32M_CONST ? "bech32m" : check === BECH32_CONST ? "bech32" : null;
  if (!variant) return { error: "bad checksum" };
  const data = words.slice(0, -6);
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const w of data) {
    acc = (acc << 5 | w) & 4095;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push(acc >> bits & 255);
    }
  }
  if (bits >= 5 || (acc & (1 << bits) - 1) !== 0) return { error: "bad padding" };
  return { hrp, bytes: Uint8Array.from(out), variant };
}
var B583 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58CheckEncode(payload) {
  const raw = Uint8Array.from([...payload, ...sha256(sha256(payload)).subarray(0, 4)]);
  let n = 0n;
  for (const b of raw) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = `${B583[Number(n % 58n)] ?? ""}${out}`;
    n /= 58n;
  }
  for (const b of raw) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}
function texToTransparent(address) {
  const d = bech32Decode(address);
  if ("error" in d || d.hrp !== "tex" || d.variant !== "bech32m" || d.bytes.length !== 20) return null;
  return base58CheckEncode(Uint8Array.from([28, 184, ...d.bytes]));
}

// apps/wheres-my-swap/src/core/origin.ts
function originKind(raw) {
  const s = raw.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return "evm";
  if (/^[0-9a-fA-F]{64}$/.test(s)) return "hex64";
  if (/^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(s)) return "solana";
  return null;
}
function sameTxHash(a, b) {
  const norm = (h) => h.trim().toLowerCase().replace(/^0x/, "");
  return norm(a) === norm(b);
}
function nearTokensFor(tokens, chainKey, assets) {
  const out = [];
  for (const asset of assets) {
    const evm = /^0x[0-9a-fA-F]{40}$/.test(asset);
    const wanted = `${chainKey}:${evm ? asset.toLowerCase() : asset}`;
    for (const t of tokens) {
      const id = evm ? t.assetId.toLowerCase() : t.assetId;
      if (id === wanted && t.nearToken.endsWith(".omft.near") && !out.includes(t.nearToken)) out.push(t.nearToken);
    }
  }
  return out;
}
function heightGuess(timeSec, a, b) {
  const perSec = (b.height - a.height) / (b.timeSec - a.timeSec || 1);
  return Math.max(1, Math.round(a.height + (timeSec - a.timeSec) * perSec));
}

// apps/wheres-my-swap/src/core/rpc.ts
var NEAR_RPC_PROVIDERS = [
  "https://rpc.mainnet.fastnear.com",
  "https://free.rpc.fastnear.com",
  "https://rpc.shitzuapes.xyz",
  "https://rpc.intea.rs",
  "https://rpc.mainnet.near.org"
];
var NEAR_ARCHIVAL_PROVIDERS = ["https://archival-rpc.mainnet.near.org"];
var NEAR_BATCH_PROVIDERS = ["https://rpc.intea.rs"];
var NEAR_BATCH_MAX = 100;
var NearRpcUnavailable = class extends Error {
  constructor(attempts, lastReason) {
    super("NEAR is busy right now: every public NEAR RPC we use is rate-limiting or unreachable. Try again in a minute.");
    this.attempts = attempts;
    this.lastReason = lastReason;
    this.name = "NearRpcUnavailable";
  }
  attempts;
  lastReason;
};
var BUSY_STATUS = /* @__PURE__ */ new Set([408, 425, 429, 500, 502, 503, 504]);
var BUSY_CAUSES = /* @__PURE__ */ new Set(["TIMEOUT_ERROR", "INTERNAL_ERROR", "NO_SYNCED_BLOCKS", "NOT_SYNCED_YET", "UNAVAILABLE_SHARD"]);
var MISSING_BLOCK_CAUSES = /* @__PURE__ */ new Set(["UNKNOWN_BLOCK", "GARBAGE_COLLECTED_BLOCK"]);
var REQUEST_ERROR_STATUS = /* @__PURE__ */ new Set([400, 422]);
var SINGLES_AT_ONCE = 4;
var isObj2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var busy = (reason, retryAfterMs2 = null) => ({ kind: "busy", reason, retryAfterMs: retryAfterMs2 });
var skip = (reason) => ({ kind: "skip", reason });
var causeOf = (err) => isObj2(err["cause"]) && typeof err["cause"]["name"] === "string" ? err["cause"]["name"] : null;
var errorName = (err) => causeOf(err) ?? (typeof err["message"] === "string" ? err["message"] : `JSON-RPC error ${String(err["code"])}`);
function judge(body, archival) {
  if (!isObj2(body)) return busy("not a JSON-RPC object");
  if ("result" in body) return { kind: "answer", value: body };
  const err = body["error"];
  if (typeof err === "string") return busy(err);
  if (!isObj2(err)) return busy("no result");
  const cause = causeOf(err);
  if (cause !== null && BUSY_CAUSES.has(cause)) return busy(cause);
  if (err["code"] === 429 || err["code"] === -32005) return busy("rate limited");
  if (err["code"] === -32601 || err["code"] === -32600 || cause === "METHOD_NOT_FOUND" || typeof err["name"] !== "string") return skip(errorName(err));
  if (!archival && cause !== null && MISSING_BLOCK_CAUSES.has(cause)) return { kind: "skip", reason: cause, missingBlock: true };
  return { kind: "answer", value: body };
}
function retryAfterMs(res) {
  const v = res.headers.get("retry-after");
  if (v === null) return null;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? s * 1e3 : null;
}
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return void 0;
  }
}
var post = (fetchImpl, provider, body) => fetchImpl(provider, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function askOne(fetchImpl, provider, body, archival) {
  const res = await post(fetchImpl, provider, body);
  if (BUSY_STATUS.has(res.status)) return busy(`HTTP ${res.status}`, retryAfterMs(res));
  if (REQUEST_ERROR_STATUS.has(res.status)) {
    const parsed = await readJson(res);
    const t = isObj2(parsed) && isObj2(parsed["error"]) ? judge(parsed, archival) : null;
    if (t === null) return skip(`HTTP ${res.status}`);
    return t.kind === "busy" ? skip(t.reason) : t;
  }
  if (!res.ok) return skip(`HTTP ${res.status}`);
  return judge(await readJson(res), archival);
}
async function askBatch(fetchImpl, provider, entries) {
  const res = await post(fetchImpl, provider, entries);
  if (BUSY_STATUS.has(res.status)) return busy(`HTTP ${res.status}`, retryAfterMs(res));
  const parsed = await readJson(res);
  if (res.ok && Array.isArray(parsed)) return { kind: "answer", value: parsed };
  if (res.ok && parsed === void 0) return busy("not JSON");
  const err = isObj2(parsed) && isObj2(parsed["error"]) ? parsed["error"] : null;
  const cause = err !== null ? causeOf(err) : null;
  if (res.ok && (err?.["code"] === 429 || cause !== null && BUSY_CAUSES.has(cause))) return busy(cause ?? "rate limited");
  const tooBig = res.status === 413 || err?.["code"] === -32010 || err?.["code"] === -32011;
  return { kind: "skip", reason: `no batch: ${err !== null ? errorName(err) : `HTTP ${res.status}`}`, forGood: !tooBig };
}
var settingsOf = (opts) => ({
  fetchImpl: opts.fetch ?? fetch,
  now: opts.now,
  sleep: opts.sleep,
  random: opts.random,
  attempts: opts.attempts ?? 3,
  budgetMs: opts.budgetMs ?? 8e3,
  onEvent: opts.onEvent
});
function walk(s, start) {
  let tried = 0;
  let asked = 0;
  let lastReason = "no provider";
  return {
    /** Up to `attempts` tries at one provider while it is busy: its answer, or null to move on. */
    async at(provider, once) {
      if (asked++ > 0) s.onEvent?.({ kind: "fallback", provider });
      for (let attempt = 1; attempt <= s.attempts; attempt++) {
        tried++;
        let t;
        try {
          t = await once();
        } catch (e) {
          t = busy(e instanceof Error ? e.message : "network error");
        }
        if (t.kind === "answer") return { value: t.value };
        lastReason = t.reason;
        if (t.kind === "skip" || attempt === s.attempts) return null;
        const waitMs = Math.round(t.retryAfterMs ?? 250 * 2 ** (attempt - 1) * (0.5 + s.random()));
        if (waitMs > s.budgetMs - (s.now() - start)) return null;
        s.onEvent?.({ kind: "retry", provider, attempt, waitMs, reason: lastReason });
        await s.sleep(waitMs);
      }
      return null;
    },
    unavailable: () => new NearRpcUnavailable(tried, lastReason)
  };
}
function nearRpc(opts) {
  const s = settingsOf(opts);
  const providers = opts.providers ?? NEAR_RPC_PROVIDERS;
  const archival = opts.archival ?? NEAR_ARCHIVAL_PROVIDERS;
  return async (body) => {
    const run = walk(s, s.now());
    let missingBlock = false;
    const ask = async (list) => {
      for (const provider of list) {
        const got2 = await run.at(provider, async () => {
          const t = await askOne(s.fetchImpl, provider, body, archival.includes(provider));
          if (t.kind === "skip" && t.missingBlock === true) missingBlock = true;
          return t;
        });
        if (got2) return got2;
      }
      return null;
    };
    const got = await ask(providers) ?? (missingBlock ? await ask(archival.filter((a) => !providers.includes(a))) : null);
    if (got) return got.value;
    throw run.unavailable();
  };
}
function pinned(params, blockId) {
  if (!isObj2(params)) return params;
  const { finality: _finality, sync_checkpoint: _syncCheckpoint, ...rest } = params;
  return { ...rest, block_id: blockId };
}
async function inTurns(items, size, work) {
  const queue = items.values();
  let failed = false;
  const worker = async () => {
    for (const item of queue) {
      if (failed) return;
      try {
        await work(item);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}
function nearRpcBatch(opts) {
  const s = settingsOf(opts);
  const batchProviders = opts.batchProviders ?? NEAR_BATCH_PROVIDERS;
  const archival = opts.archival ?? NEAR_ARCHIVAL_PROVIDERS;
  const firstSingle = (opts.providers ?? NEAR_RPC_PROVIDERS)[0];
  const refused = /* @__PURE__ */ new Set();
  return async (requests, pin) => {
    const start = s.now();
    const entries = requests.map(
      (r, i) => ({ jsonrpc: "2.0", id: i + 1, method: r.method, params: pin !== void 0 && r.method === "query" ? pinned(r.params, pin.blockId) : r.params })
    );
    const answers = /* @__PURE__ */ new Map();
    const queries = entries.filter((e) => e.method === "query");
    let batched = false;
    for (let from = 0; from < queries.length; from += NEAR_BATCH_MAX) {
      const chunk = queries.slice(from, from + NEAR_BATCH_MAX);
      const run = walk(s, start);
      for (const provider of batchProviders.filter((p) => !refused.has(p))) {
        batched = true;
        const got = await run.at(provider, async () => {
          const t = await askBatch(s.fetchImpl, provider, chunk);
          if (t.kind === "skip" && t.forGood === true) refused.add(provider);
          return t;
        });
        if (!got) continue;
        const ids = new Map(chunk.map((e) => [String(e.id), e.id]));
        for (const reply of got.value) {
          const id = isObj2(reply) ? ids.get(String(reply["id"])) : void 0;
          if (id !== void 0 && !answers.has(id) && judge(reply, archival.includes(provider)).kind === "answer") answers.set(id, reply);
        }
        break;
      }
    }
    const rest = entries.filter((e) => !answers.has(e.id));
    if (batched && firstSingle !== void 0 && rest.some((e) => e.method === "query")) s.onEvent?.({ kind: "fallback", provider: firstSingle });
    await inTurns(rest, SINGLES_AT_ONCE, async (e) => {
      const single = nearRpc({ ...opts, budgetMs: Math.max(0, s.budgetMs - (s.now() - start)) });
      answers.set(e.id, await single(e));
    });
    return entries.map((e) => answers.get(e.id));
  };
}

// apps/wheres-my-swap/src/near-views.ts
var WALL_CLOCK = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random };
var TOKENS_AT_ONCE = 100;
function nearViews(fetchImpl = fetch, providers = NEAR_RPC_PROVIDERS, clock = WALL_CLOCK) {
  const rpc = nearRpc({ providers, fetch: fetchImpl, ...clock });
  return {
    async accountExists(account) {
      try {
        return accountExistsFrom(await rpc(viewAccount(account)));
      } catch {
        return null;
      }
    },
    async intentsBalances(account) {
      try {
        const listed = viewResult(await rpc(intentsView("mt_tokens_for_owner", { account_id: account, limit: TOKENS_AT_ONCE })));
        const ids = listed ? tokenIdsFrom(listed.value) : null;
        if (!listed || !ids || ids.length >= TOKENS_AT_ONCE) return null;
        const at = { blockHeight: listed.blockHeight, blockHash: listed.blockHash };
        if (ids.length === 0) return { ...at, balances: {} };
        const amounts = viewResult(await rpc(intentsView("mt_batch_balance_of", { account_id: account, token_ids: ids }, listed.blockHash)));
        const balances = amounts ? balancesFrom(ids, amounts.value) : null;
        return balances ? { ...at, balances } : null;
      } catch {
        return null;
      }
    }
  };
}

// apps/wheres-my-swap/src/core/refund-calls.ts
var CONNECTOR = { btc: "btc-connector.bridge.near", zcash: "zcash-connector.bridge.near" };

// apps/wheres-my-swap/src/core/btc-refund.ts
var UTXO_CHAINS = {
  btc: { connector: CONNECTOR.btc, name: "Bitcoin", unit: "BTC", minor: "satoshis" },
  zcash: { connector: CONNECTOR.zcash, name: "Zcash", unit: "ZEC", minor: "zatoshis" }
};
var BTC_CONNECTOR = UTXO_CHAINS.btc.connector;
function zip317Fee(t) {
  const logical = Math.max(Math.ceil(t.transparentInputs * 150 / 150), Math.ceil(t.transparentOutputs * 34 / 34)) + t.orchardActions;
  return 5e3 * Math.max(2, logical);
}
var ZCASH_REFUND_FEE_ZAT = Math.max(
  zip317Fee({ transparentInputs: 1, transparentOutputs: 1, orchardActions: 0 }),
  zip317Fee({ transparentInputs: 1, transparentOutputs: 0, orchardActions: 1 })
);
function refundFeeFor(chain, maxBtcGasFeeSat) {
  return chain === "zcash" ? ZCASH_REFUND_FEE_ZAT : maxBtcGasFeeSat;
}
var STUCK_AFTER_SEC = 6 * 3600;
function isNearAccountId(id) {
  return /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}
function receiverOf(msg) {
  const inner = msg.safe_deposit?.msg;
  if (inner !== void 0) {
    let id = inner;
    if (inner.startsWith("{")) {
      try {
        const parsed = JSON.parse(inner);
        id = typeof parsed === "object" && parsed !== null && "receiver_id" in parsed ? parsed.receiver_id : null;
      } catch {
        id = null;
      }
    }
    if (typeof id === "string" && isNearAccountId(id)) return id;
  }
  return msg.recipient_id;
}
var isRefundOf = (spent, refundTo) => refundTo !== null && spent.inputs === 1 && spent.paysTo.length > 0 && spent.paysTo.every((a) => a === refundTo);
var loneSpendTo = (spent) => {
  const to = new Set(spent.paysTo);
  return spent.inputs === 1 && to.size === 1 ? spent.paysTo[0] ?? null : null;
};
var BATCH_OUTPUTS = 3;
var isBatch = (f) => f.outputs !== void 0 && f.outputs >= BATCH_OUTPUTS;
var REQUEST_WINDOW = {
  btc: { blocks: 52704, blockSec: 600, span: "about a year" },
  zcash: { blocks: 103680, blockSec: 75, span: "about 90 days" }
};
var requestWindowSec = (chain) => REQUEST_WINDOW[chain].blocks * REQUEST_WINDOW[chain].blockSec;
var BTC_REQUEST_WINDOW_SEC = requestWindowSec("btc");
function refundAddressOf(f) {
  return f.request?.refundAddress ?? f.msg?.refund_address ?? (f.senders.length === 1 && !isBatch(f) ? f.senders[0] ?? null : null);
}
function isCredited(f) {
  if (!f.msg || f.absorbed) return false;
  if (f.bridgeHolds) return true;
  return f.spentBy !== null && !isRefundOf(f.spentBy, refundAddressOf(f)) && loneSpendTo(f.spentBy) === null;
}
var UNREACHABLE_LOCK_SEC = 10 * 365 * 86400;

// apps/wheres-my-swap/src/btc-refund.ts
var MEMPOOL = "https://mempool.space/api";
var BLOCKCHAIR = "https://api.blockchair.com/zcash/dashboards/transaction/";
var BLOCKCHAIR_RAW = "https://api.blockchair.com/zcash/raw/transaction/";
var INDEXER = "https://mainnet.api.bridge.nearone.org/api/v3/utxo/get_deposit_message";
var isObj3 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var arr = (v) => Array.isArray(v) ? v : [];
var str2 = (v) => typeof v === "string" ? v : null;
var num = (v) => typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
function hasRefundAddress(depositMsgJson) {
  try {
    const m = JSON.parse(String(depositMsgJson));
    return isObj3(m) && typeof m["refund_address"] === "string";
  } catch {
    return false;
  }
}
var wallClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random };
function liveNearRpc(fetchImpl = fetch, onEvent, providers) {
  return nearRpc({ providers, fetch: fetchImpl, ...wallClock, onEvent });
}
function liveNearRpcBatch(fetchImpl = fetch, onEvent) {
  return nearRpcBatch({ fetch: fetchImpl, ...wallClock, onEvent });
}
function pinned2(params, blockId) {
  if (!isObj3(params)) return params;
  const { finality: _finality, ...rest } = params;
  return { ...rest, block_id: blockId };
}
function batchOver(call) {
  return (requests, pin) => Promise.all(requests.map((q, i) => call({ jsonrpc: "2.0", id: i + 1, method: q.method, params: pin && q.method === "query" ? pinned2(q.params, pin.blockId) : q.params })));
}
var publicUtxoRefundClients = (fetchImpl = fetch, rpc, batch) => {
  const call = rpc ?? liveNearRpc(fetchImpl);
  const many = batch ?? (rpc === void 0 ? liveNearRpcBatch(fetchImpl) : void 0);
  return [publicBtcRefundClient(fetchImpl, call, "btc", many), publicBtcRefundClient(fetchImpl, call, "zcash", many)];
};
function publicBtcRefundClient(fetchImpl = fetch, rpc, chain = "btc", batch) {
  const connector = UTXO_CHAINS[chain].connector;
  const call = rpc === void 0 ? liveNearRpc(fetchImpl) : typeof rpc === "string" ? liveNearRpc(fetchImpl, void 0, [rpc]) : rpc;
  const many = batch ?? (rpc === void 0 ? liveNearRpcBatch(fetchImpl) : batchOver(call));
  async function getJson(url) {
    const res = await fetchImpl(url);
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
    return res.json();
  }
  const viewRequest = (method, args) => ({
    method: "query",
    params: { request_type: "call_function", finality: "final", account_id: connector, method_name: method, args_base64: btoa(JSON.stringify(args)) }
  });
  async function view(method, args) {
    return viewValue(method, await call({ jsonrpc: "2.0", id: 1, ...viewRequest(method, args) }));
  }
  const blockOf = (body) => isObj3(body) && isObj3(body["result"]) && typeof body["result"]["block_height"] === "number" ? body["result"]["block_height"] : null;
  async function viewsAtOneBlock(views) {
    const [first, ...rest] = views;
    if (!first) return { blockHeight: null, values: [] };
    const head = await call({ jsonrpc: "2.0", id: 1, ...viewRequest(first[0], first[1]) });
    const blockHeight = blockOf(head);
    const tail = rest.length === 0 ? [] : await many(rest.map(([m, a]) => viewRequest(m, a)), blockHeight === null ? void 0 : { blockId: blockHeight });
    return { blockHeight, values: [viewValue(first[0], head), ...rest.map(([m], i) => viewValue(m, tail[i]))] };
  }
  function viewValue(method, body) {
    const result = isObj3(body) && isObj3(body["result"]) ? body["result"]["result"] : null;
    if (!Array.isArray(result)) {
      const legacy = isObj3(body) && isObj3(body["result"]) ? str2(body["result"]["error"]) : null;
      const error = isObj3(body) && isObj3(body["error"]) ? body["error"] : null;
      const cause = error && isObj3(error["cause"]) ? str2(error["cause"]["name"]) : null;
      const reason = legacy ?? cause ?? (error ? str2(error["message"]) : null);
      throw new Error(`NEAR RPC: ${method} failed${reason ? `: ${reason}` : ""}`);
    }
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(result)));
  }
  async function mempoolTx(txid) {
    const tx = await getJson(`${MEMPOOL}/tx/${txid}`);
    if (!isObj3(tx)) return null;
    const status = isObj3(tx["status"]) ? tx["status"] : {};
    const senders = [];
    for (const i of arr(tx["vin"])) {
      const a = isObj3(i) && isObj3(i["prevout"]) ? str2(i["prevout"]["scriptpubkey_address"]) : null;
      if (a && !senders.includes(a)) senders.push(a);
    }
    return {
      confirmedAtSec: status["confirmed"] === true && typeof status["block_time"] === "number" ? status["block_time"] : null,
      outputs: arr(tx["vout"]).map((o) => ({ address: isObj3(o) ? str2(o["scriptpubkey_address"]) : null, valueSat: isObj3(o) ? num(o["value"]) : 0 })),
      senders,
      inputs: arr(tx["vin"]).length,
      funding: { kind: "transparent", pools: [] }
    };
  }
  async function blockchairDashboard(txid) {
    const body = await getJson(`${BLOCKCHAIR}${txid}`);
    const data = isObj3(body) ? body["data"] : null;
    return isObj3(data) && isObj3(data[txid]) ? data[txid] : null;
  }
  async function shieldedPools(txid, dashboard) {
    const pools = /* @__PURE__ */ new Set();
    const body = await getJson(`${BLOCKCHAIR_RAW}${txid}`).catch(() => null);
    const data = isObj3(body) && isObj3(body["data"]) ? body["data"][txid] : null;
    const raw = isObj3(data) && isObj3(data["decoded_raw_transaction"]) ? data["decoded_raw_transaction"] : null;
    if (raw) {
      if (arr(raw["vjoinsplit"]).some((j) => isObj3(j) && num(j["vpub_newZat"] ?? j["vpub_new"]) > 0)) pools.add("Sprout");
      if (num(raw["valueBalanceZat"]) > 0) pools.add("Sapling");
      for (const [key, pool] of [["orchard", "Orchard"], ["ironwood", "Ironwood"]]) {
        const b = raw[key];
        if (isObj3(b) && num(b["valueBalanceZat"]) > 0) pools.add(pool);
      }
    }
    const t = isObj3(dashboard["transaction"]) ? dashboard["transaction"] : {};
    if (arr(t["join_split_raw"]).length > 0) pools.add("Sprout");
    if (num(t["shielded_value_delta"]) > 0 || arr(t["shielded_input_raw"]).length > 0) pools.add("Sapling");
    const order = ["Sprout", "Sapling", "Orchard", "Ironwood"];
    return order.filter((p) => pools.has(p));
  }
  async function blockchairTx(txid, withFunding = false) {
    const d = await blockchairDashboard(txid);
    const t = d && isObj3(d["transaction"]) ? d["transaction"] : null;
    if (!d || !t) return null;
    const senders = [];
    for (const i of arr(d["inputs"])) {
      const a = isObj3(i) ? str2(i["recipient"]) : null;
      if (a && !senders.includes(a)) senders.push(a);
    }
    const outputs = arr(d["outputs"]).filter(isObj3).sort((a, b) => num(a["index"]) - num(b["index"])).map((o) => ({ address: str2(o["recipient"]), valueSat: num(o["value"]) }));
    const time = str2(t["time"]);
    const inputs = num(t["input_count"]);
    let funding = { kind: "transparent", pools: [] };
    if (withFunding && t["is_coinbase"] !== true) {
      const pools = await shieldedPools(txid, d);
      if (inputs === 0) funding = { kind: "shielded", pools };
      else if (pools.length > 0) funding = { kind: "mixed", pools };
    }
    return {
      confirmedAtSec: num(t["block_id"]) > 0 && time ? Date.parse(`${time.replace(" ", "T")}Z`) / 1e3 : null,
      outputs,
      senders,
      inputs,
      funding
    };
  }
  async function blockchairSpentBy(txid, vout) {
    const d = await blockchairDashboard(txid);
    const o = arr(d?.["outputs"]).find((x) => isObj3(x) && num(x["index"]) === vout);
    return isObj3(o) && o["is_spent"] === true ? str2(o["spending_transaction_hash"]) : null;
  }
  const PAGE = 100;
  function requestRows(page) {
    if (!isObj3(page)) return { rows: [], full: false };
    const rows = [];
    for (const [key, r] of Object.entries(page)) {
      if (!isObj3(r)) continue;
      rows.push({
        key,
        request: {
          refundAddress: String(r["refund_address"]),
          amountSat: num(r["amount"]),
          createdAtSec: num(r["created_at_sec"]),
          executed: r["executed"] === true,
          msgHasRefundAddress: hasRefundAddress(r["deposit_msg_json"]),
          gasFeeSat: num(r["gas_fee"])
        }
      });
    }
    return { rows, full: Object.keys(page).length >= PAGE };
  }
  async function allRequests() {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const { rows, full } = requestRows(await view("get_refund_requests_paged", { from_index: from, limit: PAGE }));
      out.push(...rows);
      if (!full) return out;
    }
  }
  const CONFIG_VIEWS = [
    ["get_config", {}],
    ["required_balance_for_request_refund", {}],
    ["required_balance_for_execute_refund", {}]
  ];
  function configFrom(c, request, execute) {
    if (!isObj3(c)) throw new Error("NEAR RPC: get_config returned nothing");
    return {
      refundTimelockSec: num(c["refund_timelock_sec"]),
      unsafeRefundTimelockSec: num(c["unsafe_refund_timelock_sec"]),
      minDepositSat: num(c["min_deposit_amount"]),
      maxGasFeeSat: num(c["max_btc_gas_fee"]),
      refundFeeSat: refundFeeFor(chain, num(c["max_btc_gas_fee"])),
      requestDepositYocto: BigInt(String(request)),
      executeDepositYocto: BigInt(String(execute))
    };
  }
  return {
    chain,
    tx: chain === "btc" ? mempoolTx : (txid) => blockchairTx(txid),
    depositTx: chain === "btc" ? mempoolTx : (txid) => blockchairTx(txid, true),
    async spentBy(txid, vout) {
      if (chain === "zcash") return blockchairSpentBy(txid, vout);
      const o = await getJson(`${MEMPOOL}/tx/${txid}/outspend/${vout}`);
      return isObj3(o) && o["spent"] === true ? str2(o["txid"]) : null;
    },
    async depositMsg(address) {
      const m = await getJson(`${INDEXER}?chain=${chain}&address=${encodeURIComponent(address)}`);
      return isObj3(m) && typeof m["recipient_id"] === "string" ? m : null;
    },
    async depositAddress(msg) {
      return String(await view("get_user_deposit_address", { deposit_msg: msg }));
    },
    async depositState(key) {
      const { blockHeight, values } = await viewsAtOneBlock([
        ...CONFIG_VIEWS,
        ["list_utxos", { utxo_storage_keys: [key] }],
        ["list_unavailable_utxos", { utxo_storage_keys: [key] }],
        ["get_refund_requests_paged", { from_index: 0, limit: PAGE }]
      ]);
      const [c, request, execute, held, unavailable, page] = values;
      let { rows, full } = requestRows(page);
      for (let from = PAGE; full; from += PAGE) {
        const [next] = await many([viewRequest("get_refund_requests_paged", { from_index: from, limit: PAGE })], blockHeight === null ? void 0 : { blockId: blockHeight });
        const more = requestRows(viewValue("get_refund_requests_paged", next));
        rows = [...rows, ...more.rows];
        full = more.full;
      }
      return {
        blockHeight,
        config: configFrom(c, request, execute),
        held: isObj3(held) && held[key] != null,
        absorbed: isObj3(unavailable) && unavailable[key] != null,
        request: rows.find((r) => r.key === key)?.request ?? null
      };
    },
    async bridgeHolds(key) {
      const held = await view("list_utxos", { utxo_storage_keys: [key] });
      return isObj3(held) && held[key] != null;
    },
    async bridgeAbsorbed(key) {
      const unavailable = await view("list_unavailable_utxos", { utxo_storage_keys: [key] });
      return isObj3(unavailable) && unavailable[key] != null;
    },
    refundRequests: allRequests,
    async refundRequest(key) {
      return (await allRequests()).find((r) => r.key === key)?.request ?? null;
    },
    async config() {
      const [c, request, execute] = (await viewsAtOneBlock(CONFIG_VIEWS)).values;
      return configFrom(c, request, execute);
    }
  };
}
async function findDeposit(tx, client, vout) {
  const candidates = vout !== void 0 ? [vout] : tx.outputs.map((_, i) => i);
  for (const i of candidates) {
    const address = tx.outputs[i]?.address;
    if (!address) continue;
    const msg = await client.depositMsg(address);
    if (msg && await client.depositAddress(msg) === address) return { vout: i, msg };
  }
  return { vout: vout ?? 0, msg: null };
}
async function locate(txid, clients) {
  for (const client of clients) {
    const tx = await client.depositTx(txid).catch(() => null);
    if (tx) return { client, tx };
  }
  return null;
}
var chainNames = (clients) => clients.map((c) => UTXO_CHAINS[c.chain].name).join(" or ");
async function btcDepositFacts(raw, clients, vout) {
  const list = Array.isArray(clients) ? clients : [clients];
  const txid = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) return { error: `not a ${chainNames(list)} transaction hash (64 hex characters)` };
  const found0 = await locate(txid, list);
  if (!found0) return { error: `no ${chainNames(list)} transaction with this hash` };
  const { client, tx } = found0;
  if (vout !== void 0 && !tx.outputs[vout]) return { error: `the transaction has no output ${vout}` };
  const found = await findDeposit(tx, client, vout);
  const key = `${txid}@${found.vout}`;
  const out = tx.outputs[found.vout];
  const [state, spender] = await Promise.all([found.msg ? client.depositState(key) : Promise.resolve(null), found.msg ? client.spentBy(txid, found.vout) : Promise.resolve(null)]);
  const spendTx = spender ? await client.tx(spender) : null;
  const facts = {
    chain: client.chain,
    txid,
    vout: found.vout,
    amountSat: out?.valueSat ?? 0,
    depositAddress: out?.address ?? "",
    confirmedAtSec: tx.confirmedAtSec,
    senders: tx.senders,
    outputs: tx.outputs.length,
    msg: found.msg,
    bridgeHolds: state?.held ?? false,
    absorbed: state?.absorbed ?? false,
    spentBy: spender ? { txid: spender, inputs: spendTx?.inputs ?? 0, paysTo: (spendTx?.outputs ?? []).flatMap((o) => o.address ? [o.address] : []) } : null,
    request: state?.request ?? null,
    funding: tx.funding
  };
  return state ? { facts, client, config: state.config } : { facts, client };
}

// apps/wheres-my-swap/src/core/dust.ts
var DUST_USD = 0.05;
function dustThresholds(tokens) {
  const out = {};
  for (const t of tokens) {
    if (!(t.price > 0) || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 40) continue;
    const raw = Math.floor(DUST_USD / t.price * 10 ** t.decimals);
    if (Number.isFinite(raw) && raw > 0) out[t.assetId] = BigInt(raw).toString();
  }
  return out;
}

// apps/wheres-my-swap/src/payouts.ts
var BLOCKSCOUT = {
  eth: "https://eth.blockscout.com",
  base: "https://base.blockscout.com",
  arb: "https://arbitrum.blockscout.com",
  op: "https://explorer.optimism.io",
  gnosis: "https://gnosisscan.io"
};
var EVM_RPC = {
  eth: "https://rpc.mevblocker.io",
  base: "https://mainnet.base.org",
  arb: "https://arb1.arbitrum.io/rpc",
  op: "https://mainnet.optimism.io",
  gnosis: "https://rpc.gnosischain.com",
  bsc: "https://bsc-dataseed.bnbchain.org",
  pol: "https://rpc-mainnet.matic.quiknode.pro",
  avax: "https://api.avax.network/ext/bc/C/rpc",
  monad: "https://rpc.monad.xyz",
  xlayer: "https://rpc.xlayer.tech",
  plasma: "https://rpc.plasma.to",
  scroll: "https://rpc.scroll.io",
  adi: "https://rpc.adifoundation.ai",
  hood: "https://rpc.mainnet.chain.robinhood.com",
  bera: "https://rpc.berachain.com",
  abs: "https://api.mainnet.abs.xyz",
  // HyperEVM, Hyperliquid's own RPC (100 requests a minute per IP; no API terms found). A payout with Omni's "core"
  // message moves on to HyperCore in the same transaction: the mint to the destination is what is read.
  hlevm: "https://rpc.hyperliquid.xyz/evm",
  hypercore: "https://rpc.hyperliquid.xyz/evm"
};
var EVM_RPC_MORE = {
  eth: ["https://ethereum-rpc.publicnode.com"],
  bsc: ["https://bsc-dataseed1.bnbchain.org", "https://bsc-dataseed2.bnbchain.org"],
  pol: ["https://polygon-bor-rpc.publicnode.com"],
  avax: ["https://avalanche-c-chain-rpc.publicnode.com"],
  monad: ["https://rpc1.monad.xyz"],
  xlayer: ["https://xlayerrpc.okx.com"],
  scroll: ["https://scroll-rpc.publicnode.com"],
  hood: ["https://robinhood-rpc.publicnode.com"],
  bera: ["https://berachain-rpc.publicnode.com"],
  hlevm: ["https://rpc.hypurrscan.io"],
  hypercore: ["https://rpc.hypurrscan.io"]
};
var HOT_BRIDGE = "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd";
var BLOCKCHAIR2 = "https://api.blockchair.com/";
var BLOCKCHAIR_CHAIN = { ltc: "litecoin", doge: "dogecoin", bch: "bitcoin-cash", dash: "dash" };
var BLOCKCYPHER_CHAIN = { ltc: "ltc", doge: "doge", dash: "dash" };
var HASKOIN_BCH = "https://api.haskoin.com/bch";
var XRPL_SERVERS = ["https://xrplcluster.com/", "https://s2.ripple.com:51234/", "https://s1.ripple.com:51234/"];
var RIPPLE_EPOCH = 946684800;
var NAMED_TX_ONLY = /* @__PURE__ */ new Set(["ltc", "doge", "bch", "dash", "xrp", "sui", "ton", "stellar", "cardano", "aptos", "starknet"]);
var SUI_GRAPHQL = ["https://graphql.mainnet.sui.io/graphql", "https://api.zan.top/public/sui-mainnet/graphql"];
var SUI_QUERY = "query($d:String!){transaction(digest:$d){digest sender{address} effects{status timestamp balanceChanges(first:50){nodes{owner{address} coinType{repr} amount}}}}}";
var SUI_COIN = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
var HORIZON = ["https://horizon.stellar.org", "https://horizon.stellar.lobstr.co"];
var APTOS_REST = ["https://archive.mainnet.aptoslabs.com/v1", "https://api.mainnet.aptoslabs.com/v1"];
var APT_FA = hex64("0xa");
var STARKNET_RPC = ["https://starknet-rpc.publicnode.com"];
var OMNI_EVM_BRIDGE = {
  eth: "0xe00c629aFaCCb0510995A2B95560E446A24c85B9",
  arb: "0xd025b38762B4A4E36F0Cde483b86CB13ea00D989",
  base: "0xd025b38762B4A4E36F0Cde483b86CB13ea00D989",
  pol: "0xd025b38762B4A4E36F0Cde483b86CB13ea00D989",
  bsc: "0x073C8a225c8Cf9d3f9157F5C1a1DbE02407f5720",
  hlevm: "0xf353b40fc144d1c6c5bcdda712fa6de833016af9",
  hypercore: "0xf353b40fc144d1c6c5bcdda712fa6de833016af9"
};
var OMNI_STARKNET_BRIDGE = "0x5f9a4a841dfb7bb3cde33073b2450fe45dcd407fb6c0985a274b0e943ad8598";
var COMPLETED_TRANSFERS = "0x2f771a2a";
var IS_TRANSFER_FINALISED = "0x11667d5bee6cbca352c523fdb26683a9ddaed2d2e7d5830bd75b44542ace2b5";
var STRK = hex64("0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d");
var STARKNET_TRANSFER = hex64("0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9");
function decimalUnits(v, places) {
  const m = v ? /^(\d+)(?:\.(\d+))?$/.exec(v) : null;
  if (!m || (m[2] ?? "").length > places) return null;
  return BigInt(m[1] ?? "0") * 10n ** BigInt(places) + BigInt((m[2] ?? "").padEnd(places, "0") || "0");
}
var utxoAddress = (a) => (a ?? "").replace(/^bitcoincash:/i, "").replace(/^(ltc1|[qp][02-9ac-hj-np-z]{41}$)/i, (m) => m.toLowerCase());
var sameUtxo = (a, b) => {
  const x = utxoAddress(a);
  const y = utxoAddress(b);
  return /^(ltc1|[qp])/i.test(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
};
var HOT_WITHDRAW = "0xd9e7c316";
var ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
var TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
var TRONGRID = "https://api.trongrid.io";
var MEMPOOL2 = "https://mempool.space/api";
var SOLANA_RPC = "https://api.mainnet-beta.solana.com";
var BLOCKCHAIR_ZEC = "https://api.blockchair.com/zcash/";
var POA_BRIDGE_RPC = "https://bridge.chaindefuser.com/rpc";
var OMNI_INDEXER = "https://mainnet.api.bridge.nearone.org";
var HOT_INDEXER = "https://bridge-indexer.chaindefuser.com";
var ONE_CLICK_TOKENS = "https://1click.chaindefuser.com/v0/tokens";
var PRICES_FOR_MS = 10 * 6e4;
var MAX_PAGES = 3;
var SOL_SIGNATURES = 50;
var SOL_MAX_TX_READS = 8;
var SKEW_SEC2 = 60;
var isObj4 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var arr2 = (v) => Array.isArray(v) ? v : [];
var str3 = (v) => typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
var num2 = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
var isoSec = (v) => {
  const s = str3(v);
  const ms = s ? Date.parse(s) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1e3) : null;
};
var sameAddress = (a, b) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
function hotWithdrawCall(sent) {
  const input = str3(sent["input"]);
  if (!sameAddress(sent["to"], HOT_BRIDGE) || !input || !input.startsWith(HOT_WITHDRAW) || !/^0x[0-9a-fA-F]+$/.test(input) || input.length < 10 + 64 * 4) return null;
  const word = (k) => input.slice(10 + 64 * k, 10 + 64 * (k + 1));
  return { token: `0x${word(1).slice(-40)}`.toLowerCase(), receiver: `0x${word(2).slice(-40)}`.toLowerCase(), amount: BigInt(`0x${word(3)}`) };
}
function publicPayoutClient(fetchImpl = fetch, opts = {}) {
  const solanaRpc = opts.solanaRpc ?? SOLANA_RPC;
  async function getJson(url, init, notFound) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, init);
      if (res.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (res.status === 404 && notFound === "null") return null;
      if (!res.ok) throw new Error(`${new URL(url).host} ${new URL(url).pathname}: HTTP ${res.status}`);
      return res.json();
    }
  }
  const unsearched = (t) => ({ items: [], complete: false, unsearched: `${chainName(t.chain)}'s history is not searched here: only the payout transaction the bridge names is read` });
  const from = (t) => t.burnSec - SKEW_SEC2;
  const to = (t) => t.burnSec + SEARCH_AFTER_SEC;
  async function tron(t) {
    const native = t.asset.kind === "native";
    const q = `only_to=true&limit=50&min_timestamp=${from(t) * 1e3}&max_timestamp=${to(t) * 1e3}`;
    const r = await getJson(`${TRONGRID}/v1/accounts/${t.address}/transactions${native ? "" : "/trc20"}?${q}`);
    const data = arr2(isObj4(r) ? r["data"] : null).filter(isObj4);
    const items = [];
    for (const x of data) {
      if (native) {
        const c = arr2(isObj4(x["raw_data"]) ? x["raw_data"]["contract"] : null)[0];
        const ok = str3(isObj4(arr2(x["ret"])[0]) ? arr2(x["ret"])[0]["contractRet"] : null) === "SUCCESS";
        if (!isObj4(c) || c["type"] !== "TransferContract" || !ok) continue;
        const v = isObj4(c["parameter"]) && isObj4(c["parameter"]["value"]) ? c["parameter"]["value"] : {};
        const amount = str3(v["amount"]);
        const ts = num2(x["block_timestamp"]);
        if (amount && ts !== null && str3(x["txID"])) items.push({ tx: str3(x["txID"]), amount, timestampSec: Math.floor(ts / 1e3), from: str3(v["owner_address"]) });
      } else {
        const amount = str3(x["value"]);
        const ts = num2(x["block_timestamp"]);
        const tx = str3(x["transaction_id"]);
        if (amount && ts !== null && tx && x["to"] === t.address) items.push({ tx, amount, timestampSec: Math.floor(ts / 1e3), from: str3(x["from"]) });
      }
    }
    return { items, complete: data.length < 50 };
  }
  function btcIncoming(x, t) {
    const txid = str3(x["txid"]);
    if (!txid) return null;
    if (arr2(x["vin"]).some((v) => isObj4(v) && isObj4(v["prevout"]) && v["prevout"]["scriptpubkey_address"] === t.address)) return null;
    const paid2 = arr2(x["vout"]).reduce((s, v) => isObj4(v) && v["scriptpubkey_address"] === t.address && typeof v["value"] === "number" ? s + BigInt(v["value"]) : s, 0n);
    const status = isObj4(x["status"]) ? x["status"] : {};
    const inputs = arr2(x["vin"]).map((v) => isObj4(v) && isObj4(v["prevout"]) ? str3(v["prevout"]["scriptpubkey_address"]) : null).filter((a) => a !== null);
    const sender = inputs.find((a) => treasuryOf("btc", a) !== null) ?? inputs[0] ?? null;
    return paid2 > 0n ? { tx: txid, amount: paid2.toString(), timestampSec: status["confirmed"] === true ? num2(status["block_time"]) : null, from: sender } : null;
  }
  async function btc(t) {
    const items = [];
    let url = `${MEMPOOL2}/address/${t.address}/txs`;
    for (let page = 0; page < MAX_PAGES; page++) {
      const txs = arr2(await getJson(url)).filter(isObj4);
      let confirmed = 0;
      let reachedBurn = false;
      let lastConfirmed = null;
      for (const x of txs) {
        const status = isObj4(x["status"]) ? x["status"] : {};
        const isConfirmed = status["confirmed"] === true;
        const blockTime = num2(status["block_time"]);
        const txid = str3(x["txid"]);
        if (!txid) continue;
        if (isConfirmed) {
          confirmed++;
          lastConfirmed = txid;
          if (blockTime !== null && blockTime < from(t)) reachedBurn = true;
        }
        const paid2 = btcIncoming(x, t);
        if (paid2) items.push(paid2);
      }
      if (reachedBurn || confirmed < 25 || !lastConfirmed) return { items, complete: true };
      url = `${MEMPOOL2}/address/${t.address}/txs/chain/${lastConfirmed}`;
    }
    return { items, complete: false };
  }
  async function solRpc(method, params) {
    const r = await getJson(solanaRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (isObj4(r) && r["error"]) throw new Error(`${method}: ${JSON.stringify(r["error"]).slice(0, 120)}`);
    return isObj4(r) ? r["result"] : null;
  }
  function solIncoming(tx, signature, blockTime, t) {
    if (!isObj4(tx) || !isObj4(tx["meta"]) || !isObj4(tx["transaction"])) return null;
    if (tx["meta"]["err"]) return null;
    const meta = tx["meta"];
    const message = isObj4(tx["transaction"]["message"]) ? tx["transaction"]["message"] : {};
    const keys = arr2(message["accountKeys"]).map((k) => isObj4(k) ? str3(k["pubkey"]) : str3(k));
    const signers = arr2(message["accountKeys"]).flatMap((k) => isObj4(k) && k["signer"] === true && typeof k["pubkey"] === "string" ? [k["pubkey"]] : []);
    const sender = signers.find((a) => treasuryOf("sol", a) !== null) ?? keys[0] ?? null;
    const i = keys.indexOf(t.address);
    let amount = 0n;
    if (i >= 0) {
      const pre = num2(arr2(meta["preBalances"])[i]);
      const post3 = num2(arr2(meta["postBalances"])[i]);
      if (pre !== null && post3 !== null) amount = BigInt(post3) - BigInt(pre);
    }
    if (t.asset.kind !== "native") {
      for (const tb of arr2(meta["postTokenBalances"]).filter(isObj4)) {
        if (tb["owner"] !== t.address) continue;
        const pre = arr2(meta["preTokenBalances"]).filter(isObj4).find((p) => p["accountIndex"] === tb["accountIndex"]);
        const amt = (b) => BigInt(str3(isObj4(b) && isObj4(b["uiTokenAmount"]) ? b["uiTokenAmount"]["amount"] : null) ?? "0");
        const d = amt(tb) - amt(pre);
        if (d > 0n) amount = d;
      }
    }
    return amount > 0n ? { tx: signature, amount: amount.toString(), timestampSec: blockTime ?? num2(tx["blockTime"]), from: sender } : null;
  }
  async function sol(t) {
    const rpc = solRpc;
    const sigs = arr2(await rpc("getSignaturesForAddress", [t.address, { limit: SOL_SIGNATURES }])).filter(isObj4);
    const oldest = sigs.length ? num2(sigs[sigs.length - 1]?.["blockTime"]) : null;
    let complete = sigs.length < SOL_SIGNATURES || oldest !== null && oldest < from(t);
    const inWindow = sigs.filter((s) => !s["err"] && typeof s["signature"] === "string" && (num2(s["blockTime"]) ?? 0) >= from(t) && (num2(s["blockTime"]) ?? 0) <= to(t)).reverse();
    if (inWindow.length > SOL_MAX_TX_READS) complete = false;
    const items = [];
    for (const s of inWindow.slice(0, SOL_MAX_TX_READS)) {
      const tx = await rpc("getTransaction", [s["signature"], { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
      const paid2 = solIncoming(tx, s["signature"], num2(s["blockTime"]), t);
      if (paid2) items.push(paid2);
    }
    return { items, complete };
  }
  async function blockscoutList(t, path, read) {
    const root = BLOCKSCOUT[t.chain];
    if (!root) throw new Error(`no Blockscout explorer for ${t.chain}`);
    const items = [];
    let next = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const extra = next ? "&" + new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)])).toString() : "";
      const r = await getJson(`${root}/api/v2/addresses/${t.address}/${path}${extra}`);
      const rows = arr2(isObj4(r) ? r["items"] : null).filter(isObj4);
      let reachedBurn = false;
      for (const x of rows) {
        const ts = isoSec(x["timestamp"]);
        if (ts !== null && ts < from(t)) reachedBurn = true;
        const inc = read(x);
        if (inc) items.push(inc);
      }
      next = isObj4(r) && isObj4(r["next_page_params"]) ? r["next_page_params"] : null;
      if (!next || reachedBurn) return { items, complete: true };
    }
    return { items, complete: false };
  }
  async function evm(t) {
    if (!BLOCKSCOUT[t.chain]) return unsearched(t);
    if (t.asset.kind === "token") {
      return blockscoutList(t, `token-transfers?type=ERC-20&filter=to&token=${t.asset.contract}`, (x) => {
        const total = isObj4(x["total"]) ? x["total"] : {};
        const tx = str3(x["transaction_hash"]);
        const amount = str3(total["value"]);
        const toHash = isObj4(x["to"]) ? x["to"]["hash"] : null;
        if (!tx || !amount || !sameAddress(toHash, t.address)) return null;
        const decimals = Number(str3(total["decimals"]) ?? NaN);
        const sender = isObj4(x["from"]) ? str3(x["from"]["hash"]) : null;
        return { tx, amount, timestampSec: isoSec(x["timestamp"]), decimals: Number.isFinite(decimals) ? decimals : null, from: sender };
      });
    }
    const read = (hashKey, ok) => (x) => {
      const tx = str3(x[hashKey]);
      const amount = str3(x["value"]);
      const toHash = isObj4(x["to"]) ? x["to"]["hash"] : null;
      const sender = isObj4(x["from"]) ? str3(x["from"]["hash"]) : null;
      return tx && amount && ok(x) && sameAddress(toHash, t.address) ? { tx, amount, timestampSec: isoSec(x["timestamp"]), from: sender } : null;
    };
    const plain = await blockscoutList(t, "transactions?filter=to", read("hash", (x) => x["result"] === "success"));
    const internal = await blockscoutList(t, "internal-transactions?filter=to", read("transaction_hash", (x) => x["success"] === true));
    return { items: [...plain.items, ...internal.items], complete: plain.complete && internal.complete };
  }
  async function bridgeWithdrawal(nearTx, token) {
    const r = await getJson(POA_BRIDGE_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "withdrawal_status", params: [{ withdrawal_hash: nearTx }] })
    });
    if (!isObj4(r)) return null;
    if (r["error"]) {
      if (/not found/i.test(String(r["error"]))) return null;
      throw new Error(`withdrawal_status: ${String(r["error"]).slice(0, 120)}`);
    }
    const result = isObj4(r["result"]) ? r["result"] : {};
    const contract = token.replace(/^nep141:/, "");
    const entries = arr2(result["withdrawals"]).filter(isObj4);
    const mine = entries.find((w) => isObj4(w["data"]) && w["data"]["near_token_id"] === contract) ?? (entries.length === 1 ? entries[0] : void 0);
    if (!mine) return null;
    const data = isObj4(mine["data"]) ? mine["data"] : {};
    return { status: str3(mine["status"]) ?? "UNKNOWN", tx: str3(data["transfer_tx_hash"]) };
  }
  async function omniTransfer(nearTx, token, amount) {
    const r = await getJson(`${OMNI_INDEXER}/api/v4/transfers/transfer?transaction_hash=${encodeURIComponent(nearTx)}`, void 0, "null");
    const transfers = arr2(isObj4(r) ? r["transfers"] : null).filter(isObj4);
    const id = `near:${token.replace(/^nep141:/, "")}`;
    const forToken = transfers.filter((t) => t["origin_chain"] === "Near" && t["token_id"] === id);
    const mine = forToken.find((t) => str3(t["amount"]) === amount) ?? forToken[0];
    if (!mine) return null;
    const finalised = isObj4(mine["finalised"]) ? mine["finalised"] : {};
    const fast = isObj4(mine["fast_finalised"]) && mine["fast_finalised"]["chain"] !== "Near" ? str3(mine["fast_finalised"]["transaction_hash"]) : null;
    const destinationNonce = num2(mine["destination_nonce"]);
    return {
      source: "omni",
      status: str3(mine["status"]) ?? "UNKNOWN",
      tx: str3(mine["utxo_winning_tx_hash"]) ?? str3(finalised["transaction_hash"]),
      ...fast ? { fastTx: fast } : {},
      ...destinationNonce !== null ? { destinationNonce } : {}
    };
  }
  async function hotWithdrawal(nearTx) {
    const r = await getJson(`${HOT_INDEXER}/api/v1/withdrawals?near_trx=${encodeURIComponent(nearTx)}`, void 0, "null");
    const w = arr2(isObj4(r) ? r["withdrawals"] : null).filter(isObj4).find((x) => x["bridge"] === "HOT");
    if (!w) return null;
    return { source: "hot", status: str3(w["destination_chain_time"]) ? "COMPLETED" : "PENDING", tx: str3(w["hash"]) };
  }
  async function rpcAt(url, method, params) {
    const r = await getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (isObj4(r) && r["error"] !== void 0) throw new Error(`${new URL(url).host} ${method}: ${JSON.stringify(r["error"]).slice(0, 120)}`);
    return isObj4(r) ? r["result"] : null;
  }
  async function omniPaid(chain, destinationNonce) {
    const nonce = BigInt(destinationNonce);
    if (chain === "starknet") {
      for (const url of STARKNET_RPC) {
        const r = await rpcAt(url, "starknet_call", [{ contract_address: OMNI_STARKNET_BRIDGE, entry_point_selector: IS_TRANSFER_FINALISED, calldata: [`0x${nonce.toString(16)}`] }, "latest"]).catch(() => void 0);
        const v = arr2(r)[0];
        if (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v)) return BigInt(v) !== 0n;
      }
      return null;
    }
    const contract = OMNI_EVM_BRIDGE[chain];
    if (!contract) return null;
    for (const url of [EVM_RPC[chain], ...EVM_RPC_MORE[chain] ?? []]) {
      if (!url) continue;
      const r = await rpcAt(url, "eth_call", [{ to: contract, data: `${COMPLETED_TRANSFERS}${nonce.toString(16).padStart(64, "0")}` }, "latest"]).catch(() => void 0);
      if (typeof r === "string" && /^0x[0-9a-f]+$/i.test(r)) return BigInt(r) !== 0n;
    }
    return null;
  }
  async function evmPayoutTx(t, tx) {
    for (const url of [EVM_RPC[t.chain], ...EVM_RPC_MORE[t.chain] ?? []]) {
      if (!url) continue;
      const receipt = await rpcAt(url, "eth_getTransactionReceipt", [tx]).catch(() => null);
      if (isObj4(receipt)) return evmPaid(url, t, tx, receipt);
    }
    return null;
  }
  async function evmPaid(url, t, tx, receipt) {
    if (receipt["status"] !== "0x1") return null;
    let amount = 0n;
    let from2 = null;
    if (t.asset.kind === "token") {
      const contract = t.asset.contract;
      for (const log of arr2(receipt["logs"]).filter(isObj4)) {
        const topics = arr2(log["topics"]).map((x) => str3(x) ?? "");
        const data = str3(log["data"]);
        if (!sameAddress(log["address"], contract) || topics[0] !== TRANSFER_TOPIC || !topics[2] || !data || !/^0x[0-9a-fA-F]+$/.test(data)) continue;
        if (!sameAddress(`0x${topics[2].slice(-40)}`, t.address)) continue;
        amount += BigInt(data);
        from2 ??= topics[1] ? `0x${topics[1].slice(-40)}` : null;
      }
    }
    if (t.asset.kind === "native") {
      const sent = await rpcAt(url, "eth_getTransactionByHash", [tx]);
      if (!isObj4(sent)) return null;
      const hot = hotWithdrawCall(sent);
      const value = str3(sent["value"]);
      if (hot) {
        if (hot.receiver !== t.address.toLowerCase() || hot.token !== ZERO_ADDRESS) return null;
        amount = hot.amount;
        from2 = HOT_BRIDGE;
      } else if (sameAddress(sent["to"], t.address) && value && /^0x[0-9a-fA-F]+$/.test(value)) {
        amount = BigInt(value);
        from2 = str3(sent["from"]);
      }
    }
    if (amount === 0n) return null;
    if (t.scale) amount *= t.scale;
    const block = await rpcAt(url, "eth_getBlockByNumber", [receipt["blockNumber"], false]);
    const time = isObj4(block) ? str3(block["timestamp"]) : null;
    return { tx, amount: amount.toString(), timestampSec: time && /^0x[0-9a-fA-F]+$/.test(time) ? Number(BigInt(time)) : null, from: from2 };
  }
  async function firstKnown(sources) {
    for (const ask of sources) {
      const r = await ask().catch(() => ({ found: false }));
      if (r.found) return r.paid;
    }
    return null;
  }
  const paidUtxo = (t, tx, outputs, mined, timeSec, from2) => {
    let amount = 0n;
    for (const o of outputs) if (sameUtxo(o.to, t.address) && /^\d+$/.test(str3(o.value) ?? "")) amount += BigInt(str3(o.value) ?? "0");
    return { found: true, paid: amount > 0n ? { tx, amount: amount.toString(), timestampSec: mined ? timeSec : null, from: from2 ? utxoAddress(from2) : null } : null };
  };
  async function blockchairUtxo(t, tx) {
    const body = await getJson(`${BLOCKCHAIR2}${BLOCKCHAIR_CHAIN[t.chain] ?? t.chain}/dashboards/transaction/${tx}`);
    const data = isObj4(body) ? body["data"] : null;
    const d = isObj4(data) ? data[tx] ?? data[tx.toLowerCase()] : null;
    if (!isObj4(d) || !isObj4(d["transaction"])) return { found: false };
    const time = str3(d["transaction"]["time"]);
    const outputs = arr2(d["outputs"]).filter(isObj4).map((o) => ({ to: str3(o["recipient"]), value: o["value"] }));
    const first = arr2(d["inputs"]).filter(isObj4)[0];
    return paidUtxo(t, tx, outputs, (num2(d["transaction"]["block_id"]) ?? -1) > 0, time ? Date.parse(`${time.replace(" ", "T")}Z`) / 1e3 : null, first ? str3(first["recipient"]) : null);
  }
  async function blockcypherUtxo(t, tx) {
    const chain = BLOCKCYPHER_CHAIN[t.chain];
    if (!chain) return { found: false };
    const d = await getJson(`https://api.blockcypher.com/v1/${chain}/main/txs/${tx}`, void 0, "null");
    if (!isObj4(d) || !Array.isArray(d["outputs"])) return { found: false };
    const outputs = arr2(d["outputs"]).filter(isObj4).map((o) => ({ to: str3(arr2(o["addresses"])[0]), value: o["value"] }));
    const first = arr2(d["inputs"]).filter(isObj4)[0];
    return paidUtxo(t, tx, outputs, (num2(d["block_height"]) ?? -1) > 0, isoSec(d["confirmed"]), first ? str3(arr2(first["addresses"])[0]) : null);
  }
  async function haskoinBch(t, tx) {
    if (t.chain !== "bch") return { found: false };
    const d = await getJson(`${HASKOIN_BCH}/transaction/${tx}`, void 0, "null");
    if (!isObj4(d) || !Array.isArray(d["outputs"])) return { found: false };
    const outputs = arr2(d["outputs"]).filter(isObj4).map((o) => ({ to: str3(o["address"]), value: o["value"] }));
    const first = arr2(d["inputs"]).filter(isObj4)[0];
    return paidUtxo(t, tx, outputs, isObj4(d["block"]) && num2(d["block"]["height"]) !== null, num2(d["time"]), first ? str3(first["address"]) : null);
  }
  async function xrpLookup(url, t, tx) {
    const r = await getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "tx", params: [{ transaction: tx, binary: false }] }) });
    const res = isObj4(r) && isObj4(r["result"]) ? r["result"] : null;
    if (!res || res["error"] !== void 0) return { found: false };
    const meta = isObj4(res["meta"]) ? res["meta"] : {};
    const delivered = meta["delivered_amount"];
    const tagOk = t.tag === void 0 || String(res["DestinationTag"] ?? "") === t.tag;
    const pays = res["TransactionType"] === "Payment" && meta["TransactionResult"] === "tesSUCCESS" && res["Destination"] === t.address && tagOk && t.asset.kind === "native" && typeof delivered === "string" && /^\d+$/.test(delivered);
    const date = num2(res["date"]);
    return { found: true, paid: pays ? { tx, amount: String(delivered), timestampSec: res["validated"] === true && date !== null ? date + RIPPLE_EPOCH : null, from: str3(res["Account"]) } : null };
  }
  const post2 = (url, body, headers = {}) => getJson(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const paid = (tx, amount, timestampSec, from2) => ({ found: true, paid: amount > 0n ? { tx, amount: amount.toString(), timestampSec, from: from2 } : null });
  async function suiLookup(url, t, tx) {
    const r = await post2(url, { query: SUI_QUERY, variables: { d: tx } });
    const data = isObj4(r) && isObj4(r["data"]) ? r["data"] : null;
    const txn = data && isObj4(data["transaction"]) ? data["transaction"] : null;
    if (!txn) return { found: false };
    const eff = isObj4(txn["effects"]) ? txn["effects"] : {};
    if (eff["status"] !== "SUCCESS" || t.asset.kind !== "native") return { found: true, paid: null };
    let amount = 0n;
    for (const n of arr2(isObj4(eff["balanceChanges"]) ? eff["balanceChanges"]["nodes"] : null).filter(isObj4)) {
      const owner = isObj4(n["owner"]) ? str3(n["owner"]["address"]) : null;
      const coin = isObj4(n["coinType"]) ? str3(n["coinType"]["repr"]) : null;
      const amt = str3(n["amount"]);
      if (owner && hex64(owner) === t.address && coin === SUI_COIN && amt && /^-?\d+$/.test(amt)) amount += BigInt(amt);
    }
    return paid(tx, amount, isoSec(eff["timestamp"]), isObj4(txn["sender"]) ? str3(txn["sender"]["address"]) : null);
  }
  async function tonLookup(source, t, tx) {
    const dest = tonRaw(t.address);
    if (!dest || t.asset.kind !== "native") return { found: false };
    if (source === "toncenter") {
      const r = await getJson(`https://toncenter.com/api/v3/transactions?hash=${encodeURIComponent(tx)}`, void 0, "null");
      const x2 = isObj4(r) ? arr2(r["transactions"]).filter(isObj4)[0] : void 0;
      if (!x2) return { found: false };
      const m2 = isObj4(x2["in_msg"]) ? x2["in_msg"] : {};
      const credit2 = isObj4(x2["description"]) && isObj4(x2["description"]["credit_ph"]) ? str3(x2["description"]["credit_ph"]["credit"]) : null;
      const ok2 = tonRaw(str3(x2["account"]) ?? "") === dest && m2["bounce"] === false && m2["opcode"] === null && credit2 !== null && x2["emulated"] !== true;
      const value2 = str3(m2["value"]);
      return paid(tx, ok2 && value2 && /^\d+$/.test(value2) ? BigInt(value2) : 0n, x2["finality"] === "finalized" ? num2(x2["now"]) : null, tonRaw(str3(m2["source"]) ?? ""));
    }
    const x = await getJson(`https://tonapi.io/v2/blockchain/transactions/${encodeURIComponent(tx)}`, void 0, "null");
    if (!isObj4(x) || !isObj4(x["in_msg"])) return { found: false };
    const m = x["in_msg"];
    const account = isObj4(x["account"]) ? str3(x["account"]["address"]) : null;
    const credit = isObj4(x["credit_phase"]) ? str3(x["credit_phase"]["credit"]) : null;
    const ok = tonRaw(account ?? "") === dest && m["bounce"] === false && m["op_code"] == null && credit !== null;
    const value = str3(m["value"]);
    return paid(tx, ok && value && /^\d+$/.test(value) ? BigInt(value) : 0n, num2(x["utime"]), isObj4(m["source"]) ? tonRaw(str3(m["source"]["address"]) ?? "") : null);
  }
  async function stellarLookup(root, t, tx) {
    const r = await getJson(`${root}/transactions/${encodeURIComponent(tx)}/operations?limit=200&join=transactions`, { headers: { "user-agent": "WheresMySwap/1" } }, "null");
    const records = isObj4(r) && isObj4(r["_embedded"]) ? arr2(r["_embedded"]["records"]).filter(isObj4) : [];
    if (records.length === 0) return { found: false };
    const first = records[0] ?? {};
    const txn = isObj4(first["transaction"]) ? first["transaction"] : {};
    if (first["transaction_successful"] !== true) return { found: true, paid: null };
    const assetOk = (type, code, issuer) => t.asset.kind === "native" ? type === "native" : t.asset.kind === "token" && `${String(code)}:${String(issuer)}` === t.asset.contract;
    let amount = 0n;
    let from2 = null;
    for (const op of records) {
      for (const c of arr2(op["asset_balance_changes"]).filter(isObj4)) {
        if (c["type"] !== "transfer" || c["to"] !== t.address || !assetOk(c["asset_type"], c["asset_code"], c["asset_issuer"])) continue;
        amount += decimalUnits(str3(c["amount"]), 7) ?? 0n;
        from2 ??= str3(c["from"]);
      }
      if ((op["type"] === "payment" || op["type"] === "path_payment_strict_send" || op["type"] === "path_payment_strict_receive") && op["to"] === t.address && assetOk(op["asset_type"], op["asset_code"], op["asset_issuer"])) {
        amount += decimalUnits(str3(op["amount"]), 7) ?? 0n;
        from2 ??= str3(op["from"]);
      }
      if (op["type"] === "create_account" && op["account"] === t.address && t.asset.kind === "native") {
        amount += decimalUnits(str3(op["starting_balance"]), 7) ?? 0n;
        from2 ??= str3(op["funder"]);
      }
    }
    return paid(tx, amount, isoSec(txn["created_at"]), from2);
  }
  async function cardanoLookup(source, t, tx) {
    if (t.asset.kind !== "native") return { found: false };
    let outs;
    let time;
    let from2;
    if (source === "yoroi") {
      const r = await post2("https://api.yoroiwallet.com/api/v2/txs/get", { txHashes: [tx] });
      const d = isObj4(r) && isObj4(r[tx]) ? r[tx] : null;
      if (!d) return { found: false };
      if (d["tx_state"] !== "Successful") return { found: true, paid: null };
      outs = arr2(d["outputs"]).filter(isObj4).map((o) => ({ address: str3(o["address"]), value: str3(o["amount"]), tokens: arr2(o["assets"]).length }));
      time = isoSec(d["time"]);
      from2 = str3(arr2(d["inputs"]).filter(isObj4)[0]?.["address"]);
    } else if (source === "koios") {
      const r = await post2("https://api.koios.rest/api/v1/tx_info", { _tx_hashes: [tx], _inputs: true, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false });
      const d = arr2(r).filter(isObj4).find((x) => x["tx_hash"] === tx);
      if (!d) return { found: false };
      const addr = (o) => isObj4(o["payment_addr"]) ? str3(o["payment_addr"]["bech32"]) : null;
      outs = arr2(d["outputs"]).filter(isObj4).map((o) => ({ address: addr(o), value: str3(o["value"]), tokens: arr2(o["asset_list"]).length }));
      time = num2(d["tx_timestamp"]);
      const input = arr2(d["inputs"]).filter(isObj4)[0];
      from2 = input ? addr(input) : null;
    } else {
      const r = await getJson(`https://api.adastat.net/rest/v1/transactions/${encodeURIComponent(tx)}.json`, void 0, "null");
      const d = isObj4(r) && isObj4(r["data"]) ? r["data"] : null;
      if (!d) return { found: false };
      const rows = (k) => isObj4(d[k]) ? arr2(d[k]["rows"]).filter(isObj4) : [];
      outs = rows("outputs").map((o) => ({ address: str3(o["address"]), value: str3(o["amount"]), tokens: arr2(o["tokens"]).length }));
      time = num2(d["time"]);
      from2 = str3(rows("inputs")[0]?.["address"]);
    }
    let amount = 0n;
    for (const o of outs) if (o.address === t.address && o.tokens === 0 && o.value && /^\d+$/.test(o.value)) amount += BigInt(o.value);
    return paid(tx, amount, time, from2);
  }
  async function aptosLookup(root, t, tx) {
    const r = await getJson(`${root}/transactions/by_hash/${encodeURIComponent(tx)}`, void 0, "null");
    if (!isObj4(r) || r["type"] !== "user_transaction") return { found: false };
    if (r["success"] !== true || t.asset.kind !== "native") return { found: true, paid: null };
    const changes = arr2(r["changes"]).filter(isObj4).filter((c) => c["type"] === "write_resource" && isObj4(c["data"]));
    const resource = (address, type) => {
      const c = changes.find((x) => hex64(str3(x["address"]) ?? "") === address && isObj4(x["data"]) && x["data"]["type"] === type);
      return c && isObj4(c["data"]) && isObj4(c["data"]["data"]) ? c["data"]["data"] : null;
    };
    let amount = 0n;
    for (const e of arr2(r["events"]).filter(isObj4)) {
      const data = isObj4(e["data"]) ? e["data"] : {};
      const value = str3(data["amount"]);
      if (!value || !/^\d+$/.test(value)) continue;
      if (e["type"] === "0x1::fungible_asset::Deposit") {
        const store = hex64(str3(data["store"]) ?? "");
        const owner = str3(resource(store, "0x1::object::ObjectCore")?.["owner"]);
        const meta = resource(store, "0x1::fungible_asset::FungibleStore")?.["metadata"];
        if (owner && hex64(owner) === t.address && isObj4(meta) && hex64(str3(meta["inner"]) ?? "") === APT_FA) amount += BigInt(value);
      } else if (e["type"] === "0x1::coin::DepositEvent") {
        const account = isObj4(e["guid"]) ? hex64(str3(e["guid"]["account_address"]) ?? "") : "";
        if (account === t.address && resource(account, "0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>")) amount += BigInt(value);
      }
    }
    const micros = str3(r["timestamp"]);
    return paid(tx, amount, micros && /^\d+$/.test(micros) ? Number(BigInt(micros) / 1000000n) : null, str3(r["sender"]) ? hex64(str3(r["sender"]) ?? "") : null);
  }
  async function starknetLookup(url, t, tx) {
    const r = await post2(url, { jsonrpc: "2.0", id: 1, method: "starknet_getTransactionReceipt", params: [tx] });
    const res = isObj4(r) && isObj4(r["result"]) ? r["result"] : null;
    if (!res) return { found: false };
    if (res["execution_status"] !== "SUCCEEDED" || t.asset.kind !== "native") return { found: true, paid: null };
    let amount = 0n;
    let from2 = null;
    for (const e of arr2(res["events"]).filter(isObj4)) {
      const keys = arr2(e["keys"]).map((k) => hex64(str3(k) ?? "0"));
      const data = arr2(e["data"]).map((k) => str3(k) ?? "0x0");
      if (hex64(str3(e["from_address"]) ?? "") !== STRK || keys[0] !== STARKNET_TRANSFER) continue;
      const [sender, to2, low, high] = keys.length >= 3 ? [keys[1], keys[2], data[0], data[1]] : [hex64(data[0] ?? "0"), hex64(data[1] ?? "0"), data[2], data[3]];
      if (to2 !== t.address) continue;
      amount += BigInt(low ?? "0x0") + (BigInt(high ?? "0x0") << 128n);
      from2 ??= sender ?? null;
    }
    let time = null;
    if (amount > 0n && num2(res["block_number"]) !== null) {
      const b = await post2(url, { jsonrpc: "2.0", id: 1, method: "starknet_getBlockWithTxHashes", params: [{ block_number: num2(res["block_number"]) }] }).catch(() => null);
      time = isObj4(b) && isObj4(b["result"]) ? num2(b["result"]["timestamp"]) : null;
    }
    return paid(tx, amount, time, from2);
  }
  async function payoutTx(t, tx) {
    if (t.chain === "sui") return firstKnown(SUI_GRAPHQL.map((url) => () => suiLookup(url, t, tx)));
    if (t.chain === "ton") return firstKnown([() => tonLookup("toncenter", t, tx), () => tonLookup("tonapi", t, tx)]);
    if (t.chain === "stellar") return firstKnown(HORIZON.map((root) => () => stellarLookup(root, t, tx)));
    if (t.chain === "cardano") return firstKnown([() => cardanoLookup("yoroi", t, tx), () => cardanoLookup("koios", t, tx), () => cardanoLookup("adastat", t, tx)]);
    if (t.chain === "aptos") return firstKnown(APTOS_REST.map((root) => () => aptosLookup(root, t, tx)));
    if (t.chain === "starknet") return firstKnown(STARKNET_RPC.map((url) => () => starknetLookup(url, t, tx)));
    if (BLOCKCHAIR_CHAIN[t.chain]) return firstKnown([() => blockchairUtxo(t, tx), () => blockcypherUtxo(t, tx), () => haskoinBch(t, tx)]);
    if (t.chain === "xrp") return firstKnown(XRPL_SERVERS.map((url) => () => xrpLookup(url, t, tx)));
    if (t.chain === "sol") return solIncoming(await solRpc("getTransaction", [tx, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]), tx, null, t);
    if (t.chain === "btc") {
      const x = await getJson(`${MEMPOOL2}/tx/${tx}`, void 0, "null");
      return isObj4(x) ? btcIncoming(x, t) : null;
    }
    if (EVM_RPC[t.chain]) return evmPayoutTx(t, tx);
    return null;
  }
  async function zcashTx(txid) {
    const body = await getJson(`${BLOCKCHAIR_ZEC}dashboards/transaction/${txid}`, void 0, "null");
    const data = isObj4(body) ? body["data"] : null;
    const d = isObj4(data) ? data[txid] : null;
    if (!isObj4(d) || !isObj4(d["transaction"])) return null;
    const t = d["transaction"];
    const time = str3(t["time"]);
    const outputs = arr2(d["outputs"]).filter(isObj4).sort((a, b) => (num2(a["index"]) ?? 0) - (num2(b["index"]) ?? 0)).map((o) => ({ address: str3(o["recipient"]), valueZat: BigInt(str3(o["value"]) ?? "0") }));
    const raw = await getJson(`${BLOCKCHAIR_ZEC}raw/transaction/${txid}`, void 0, "null").catch(() => null);
    const rawData = isObj4(raw) && isObj4(raw["data"]) ? raw["data"][txid] : null;
    const decoded = isObj4(rawData) && isObj4(rawData["decoded_raw_transaction"]) ? rawData["decoded_raw_transaction"] : {};
    const shieldedIn = [];
    const into = (pool, balance) => {
      const v = num2(balance);
      if (v !== null && v < 0) shieldedIn.push({ pool, zat: BigInt(-v) });
    };
    into("Sapling", decoded["valueBalanceZat"]);
    for (const [key, pool] of [["orchard", "Orchard"], ["ironwood", "Ironwood"]]) {
      const b = decoded[key];
      if (isObj4(b)) into(pool, b["valueBalanceZat"]);
    }
    return { confirmedAtSec: (num2(t["block_id"]) ?? -1) > 0 && time ? Date.parse(`${time.replace(" ", "T")}Z`) / 1e3 : null, outputs, shieldedIn };
  }
  let prices = null;
  function dustBelow() {
    if (prices && Date.now() - prices.at < PRICES_FOR_MS) return prices.thresholds;
    const thresholds = getJson(ONE_CLICK_TOKENS).then(
      (r) => dustThresholds(
        arr2(r).filter(isObj4).flatMap((t) => {
          const assetId = str3(t["assetId"]);
          const decimals = num2(t["decimals"]);
          const price = num2(t["price"]);
          return assetId && decimals !== null && price !== null ? [{ assetId, decimals, price }] : [];
        })
      )
    );
    prices = { at: Date.now(), thresholds };
    thresholds.catch(() => {
      prices = null;
    });
    return thresholds;
  }
  return {
    bridgeWithdrawal,
    omniTransfer,
    omniPaid,
    hotWithdrawal,
    payoutTx,
    zcashTx,
    dustBelow,
    incoming(t) {
      if (NAMED_TX_ONLY.has(t.chain)) return Promise.resolve(unsearched(t));
      if (t.chain === "tron") return tron(t);
      if (t.chain === "btc") return btc(t);
      if (t.chain === "sol") return sol(t);
      return evm(t);
    }
  };
}

// apps/wheres-my-swap/src/origin.ts
var OMNI_CHAIN2 = { Eth: "eth", Sol: "sol", Arb: "arb", Base: "base", Bnb: "bsc", Pol: "pol", HyperEvm: "hlevm", Strk: "starknet", Btc: "btc", Zcash: "zec" };
var REFUND_HINT = "check whether it can be refunded with: btc-refund ";
var CHAIN_ID = { eth: "1", base: "8453", arb: "42161", op: "10", gnosis: "100" };
var TRONGRID2 = "https://api.trongrid.io";
var MEMPOOL3 = "https://mempool.space/api";
var isObj5 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var arr3 = (v) => Array.isArray(v) ? v : [];
var str4 = (v) => typeof v === "string" ? v : null;
var B584 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
async function tronBase58(hex) {
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
  const once = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const twice = new Uint8Array(await crypto.subtle.digest("SHA-256", once));
  const full = new Uint8Array([...bytes, ...twice.slice(0, 4)]);
  let n = full.reduce((acc, b) => acc * 256n + BigInt(b), 0n);
  let out = "";
  while (n > 0n) {
    out = (B584[Number(n % 58n)] ?? "") + out;
    n /= 58n;
  }
  for (const b of full) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
function publicOriginClient(fetchImpl = fetch) {
  async function getJson(url, init) {
    const res = await fetchImpl(url, init);
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
    return res.json();
  }
  const post2 = (url, body) => getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  async function tron(hash) {
    const tx = await post2(`${TRONGRID2}/wallet/gettransactionbyid`, { value: hash });
    const contract = isObj5(tx) && isObj5(tx["raw_data"]) ? arr3(tx["raw_data"]["contract"])[0] : null;
    if (!isObj5(contract)) return null;
    const info = await post2(`${TRONGRID2}/wallet/gettransactioninfobyid`, { value: hash });
    const ms = isObj5(info) && typeof info["blockTimeStamp"] === "number" ? info["blockTimeStamp"] : null;
    if (ms === null) return null;
    const value = isObj5(contract["parameter"]) && isObj5(contract["parameter"]["value"]) ? contract["parameter"]["value"] : {};
    const token = contract["type"] === "TriggerSmartContract" ? str4(value["contract_address"]) : null;
    return { chainKey: "tron:mainnet", chain: "tron", timeSec: Math.floor(ms / 1e3), assets: [token ? await tronBase58(token) : "native"] };
  }
  async function btc(hash) {
    const tx = await getJson(`${MEMPOOL3}/tx/${hash}`);
    const status = isObj5(tx) && isObj5(tx["status"]) ? tx["status"] : null;
    const t = status && typeof status["block_time"] === "number" ? status["block_time"] : null;
    return t === null ? null : { chainKey: "btc:mainnet", chain: "btc", timeSec: t, assets: ["native"] };
  }
  async function evmOn(chain, hash) {
    const root = BLOCKSCOUT[chain];
    const id = CHAIN_ID[chain];
    if (!root || !id) return null;
    const tx = await getJson(`${root}/api/v2/transactions/${hash}`);
    if (!isObj5(tx)) return null;
    const ms = Date.parse(str4(tx["timestamp"]) ?? "");
    if (!Number.isFinite(ms)) return null;
    const assets = [];
    for (const t of arr3(tx["token_transfers"])) {
      const tok = isObj5(t) && isObj5(t["token"]) ? str4(t["token"]["address_hash"]) ?? str4(t["token"]["address"]) : null;
      if (tok && !assets.includes(tok)) assets.push(tok);
    }
    if (str4(tx["value"]) && str4(tx["value"]) !== "0") assets.push("native");
    return { chainKey: `eth:${id}`, chain, timeSec: Math.floor(ms / 1e3), assets };
  }
  async function evmRpc(chain, method, params) {
    const url = EVM_RPC[chain];
    if (!url) return null;
    const r = await post2(url, { jsonrpc: "2.0", id: 1, method, params });
    if (isObj5(r) && r["error"] !== void 0) throw new Error(`${new URL(url).host} ${method}: ${JSON.stringify(r["error"]).slice(0, 120)}`);
    return isObj5(r) ? r["result"] : null;
  }
  async function evmRpcOn(chain, hash) {
    const id = CHAIN_ID[chain];
    const tx = id ? await evmRpc(chain, "eth_getTransactionByHash", [hash]) : null;
    if (!id || !isObj5(tx)) return null;
    const height = str4(tx["blockNumber"]);
    if (!height) return null;
    const receipt = await evmRpc(chain, "eth_getTransactionReceipt", [hash]);
    const block = await evmRpc(chain, "eth_getBlockByNumber", [height, false]);
    const time = isObj5(block) ? str4(block["timestamp"]) : null;
    if (!time || !/^0x[0-9a-fA-F]+$/.test(time)) return null;
    const assets = [];
    for (const log of arr3(isObj5(receipt) ? receipt["logs"] : null).filter(isObj5)) {
      const token = str4(log["address"]);
      if (token && arr3(log["topics"])[0] === TRANSFER_TOPIC && !assets.includes(token)) assets.push(token);
    }
    const value = str4(tx["value"]);
    if (value && /^0x[0-9a-fA-F]+$/.test(value) && BigInt(value) !== 0n) assets.push("native");
    return { chainKey: `eth:${id}`, chain, timeSec: Number(BigInt(time)), assets };
  }
  async function evm(hash) {
    const found = await Promise.all(
      Object.keys(CHAIN_ID).map(async (c) => await evmOn(c, hash).catch(() => null) ?? await evmRpcOn(c, hash).catch(() => null))
    );
    return found.find((f) => f !== null) ?? null;
  }
  const utxoBridges = publicUtxoRefundClients(fetchImpl);
  async function omniOrigin(hash) {
    const r = await getJson(`${OMNI_INDEXER}/api/v4/transfers/transfer?transaction_hash=${encodeURIComponent(hash)}`);
    const transfers = arr3(isObj5(r) ? r["transfers"] : null).filter(isObj5);
    const t = transfers.find((x) => x["destination_chain"] === "Near" && x["origin_chain"] !== "Near" && isObj5(x["initialised"]) && sameTxHash(str4(x["initialised"]["transaction_hash"]) ?? "", hash));
    if (!t) return null;
    const recipient = (str4(t["recipient"]) ?? "").replace(/^near:/, "");
    let named = str4(t["msg"]);
    if (typeof named === "string" && named.startsWith("{")) {
      try {
        const m = JSON.parse(named);
        named = isObj5(m) ? m["receiver_id"] : null;
      } catch {
        named = null;
      }
    }
    const account = recipient === "intents.near" && typeof named === "string" && isNearAccountId(named.toLowerCase()) ? named.toLowerCase() : null;
    const origin = str4(t["origin_chain"]) ?? "?";
    return {
      chain: OMNI_CHAIN2[origin] ?? origin.toLowerCase(),
      status: str4(t["status"]) ?? "UNKNOWN",
      account,
      paidTo: recipient && recipient !== "intents.near" ? recipient : null,
      nearTx: isObj5(t["finalised"]) ? str4(t["finalised"]["transaction_hash"]) : null
    };
  }
  return {
    omniOrigin,
    async omniUtxo(hash) {
      const r = await btcDepositFacts(hash, utxoBridges);
      if ("error" in r || !r.facts.msg) return null;
      return { account: receiverOf(r.facts.msg), credited: isCredited(r.facts), chain: r.facts.chain };
    },
    async lookup(hash) {
      const kind = originKind(hash);
      const h = hash.trim();
      if (kind === "evm") return evm(h);
      if (kind === "hex64") return await tron(h.toLowerCase()).catch(() => null) ?? await btc(h.toLowerCase()).catch(() => null);
      return null;
    },
    async bridgeTokens(chainKey) {
      const r = await post2(POA_BRIDGE_RPC, { jsonrpc: "2.0", id: 1, method: "supported_tokens", params: [{ chains: [chainKey] }] });
      const tokens = isObj5(r) && isObj5(r["result"]) ? arr3(r["result"]["tokens"]) : [];
      return tokens.flatMap((t) => {
        const address = isObj5(t) ? str4(t["origin_chain_address"]) : null;
        const nearToken = isObj5(t) ? str4(t["near_token_id"]) : null;
        return address && nearToken ? [{ assetId: `${chainKey}:${address}`, nearToken }] : [];
      });
    }
  };
}
function fromOmni(o, hash) {
  const name = chainName(o.chain);
  if (o.account) return { account: o.account, chain: o.chain, originTx: hash, ...o.nearTx ? { depositTx: o.nearTx } : {}, via: "omni" };
  if (o.paidTo) return { notFound: `this ${name} transaction is an Omni bridge transfer to the NEAR account ${o.paidTo}, not a deposit into NEAR Intents` };
  if (!o.nearTx) return { notFound: `this ${name} deposit reached the Omni bridge (${o.status}) and is not on NEAR yet: check again in a few minutes` };
  return { notFound: `the Omni bridge finalised this ${name} deposit in NEAR transaction ${o.nearTx}, but its record names no NEAR Intents account: paste that transaction` };
}
var SEARCH_SEC = 2 * 3600;
var START_EARLY_SEC = 120;
var MAX_READS = 400;
async function heightAt(near, account, timeSec) {
  const latest = await near.latestTx(account);
  if (!latest) throw new Error(`no NEAR history for ${account}`);
  let a = latest;
  let b = { height: Math.max(1, Math.round(latest.height - (latest.timeSec - timeSec) * 1.6)), timeSec: 0 };
  for (let i = 0; i < 5; i++) {
    const t = await near.blockTime(b.height);
    if (t === null) break;
    b = { height: b.height, timeSec: t };
    if (Math.abs(t - timeSec) <= 30) break;
    const next = heightGuess(timeSec, a, b);
    a = b;
    b = { height: next, timeSec: 0 };
  }
  return b.height;
}
var SOURCES = "TRON, Bitcoin, Zcash (Omni bridge), Ethereum, Base, Arbitrum, Optimism or Gnosis";
async function findOrderByOrigin(raw, near, origin) {
  const hash = raw.trim();
  const kind = originKind(hash);
  if (!kind) return { notFound: "not an origin-chain transaction hash" };
  if ((kind === "solana" || kind === "evm") && origin.omniOrigin) {
    const omni = await origin.omniOrigin(hash).catch(() => null);
    if (omni) return fromOmni(omni, hash);
  }
  if (kind === "solana") return { notFound: "the Omni bridge has no transfer started by this Solana transaction, and Solana deposits through the PoA bridge are not searchable yet: paste the NEAR order account or a NEAR transaction" };
  if (!near.blockTime || !near.latestTx || !near.accountTxsBetween) return { notFound: "this NEAR client cannot search by block range" };
  const nearRange = { blockTime: near.blockTime, latestTx: near.latestTx };
  if (kind === "hex64" && origin.omniUtxo) {
    const omni = await origin.omniUtxo(hash).catch(() => null);
    if (omni?.credited) return { account: omni.account, chain: omni.chain, originTx: hash };
    if (omni) {
      const { name, unit } = UTXO_CHAINS[omni.chain];
      return { notFound: `this ${name} deposit reached the Omni ${unit} bridge but was never credited on NEAR (order ${omni.account}); ${REFUND_HINT}${hash}` };
    }
  }
  const tx = await origin.lookup(hash);
  if (!tx) return { notFound: `no transaction with this hash on ${SOURCES}` };
  const tokens = nearTokensFor(await origin.bridgeTokens(tx.chainKey), tx.chainKey, tx.assets);
  if (tokens.length === 0) {
    return { notFound: tx.chain === "btc" ? "this Bitcoin deposit did not go through the PoA bridge (Omni BTC deposits are not searchable by transaction yet)" : `the PoA bridge carries none of the assets this ${tx.chain} transaction moved` };
  }
  for (const token of tokens) {
    const from = await heightAt(nearRange, token, tx.timeSec - START_EARLY_SEC);
    const to = from + Math.round(SEARCH_SEC * 1.7);
    const candidates = (await near.accountTxsBetween(token, from, to, MAX_READS)).slice(0, MAX_READS);
    for (let i = 0; i < candidates.length; i += 20) {
      for (const t of await near.transactions(candidates.slice(i, i + 20).map((c) => c.hash))) {
        const o = originOf(t);
        if (o.status !== "proven" || o.kind !== "poa" || !sameTxHash(o.txHash, hash)) continue;
        const account = findOrderAccount(t);
        if (account) return { account, depositTx: t.hash, chain: tx.chain, originTx: hash };
      }
    }
  }
  return { notFound: `no NEAR Intents deposit names this ${tx.chain} transaction in the 2 hours after it (searched ${tokens.join(", ")})` };
}

// apps/wheres-my-swap/src/check.ts
var IMPLICIT = /^[0-9a-f]{64}$/;
var ETH_LIKE = /^0x[0-9a-f]{40}$/;
var DETERMINISTIC = /^0s[0-9a-f]{40}$/;
var UNIVERSAL = /^0u[0-9a-hjkmnp-tv-z]{51}[0g]$/;
var NAMED2 = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
var BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
var EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
function resolveInput(raw) {
  const s = raw.trim();
  const lower = s.toLowerCase();
  if (EVM_HASH.test(s)) return { kind: "unsupported", reason: "origin-chain transaction hashes are not searchable yet; paste the NEAR transaction or the order account" };
  if (ETH_LIKE.test(lower) || DETERMINISTIC.test(lower) || UNIVERSAL.test(lower) || IMPLICIT.test(lower)) return { kind: "account", account: lower };
  if (BASE58_HASH.test(s)) return { kind: "tx", hash: s };
  if (NAMED2.test(lower)) return { kind: "account", account: lower };
  return { kind: "unsupported", reason: "not a NEAR account or transaction hash" };
}
function fastnearUnavailable(e) {
  if (e instanceof TypeError) return /fetch|network|load failed/i.test(e.message);
  if (!(e instanceof Error)) return false;
  const m = /^FastNEAR \S+: HTTP (\d{3})$/.exec(e.message);
  if (!m) return false;
  const status = Number(m[1]);
  return status === 429 || status === 401 || status === 403 || status >= 500;
}
var SOURCE_NAME = { nearblocks: "NearBlocks" };
async function checkOrderWithFallback(input, client, nowNs, params, payouts, origins, fallback) {
  try {
    return await checkOrder(input, client, nowNs, params, payouts, origins);
  } catch (e) {
    if (!fallback || !fastnearUnavailable(e)) throw e;
    const reason = e instanceof Error ? e.message : String(e);
    try {
      return { ...await checkOrder(input, fallback.client(), nowNs, params, payouts, origins), historySource: fallback.source };
    } catch (e2) {
      throw new Error(`FastNEAR is unavailable (${reason}), and the backup source, ${SOURCE_NAME[fallback.source]}, could not answer either: ${e2 instanceof Error ? e2.message : String(e2)}`, { cause: e2 });
    }
  }
}
async function checkOrder(input, client, nowNs, params, payouts, origins) {
  const dusting = !params?.dustBelow && payouts?.dustBelow ? payouts.dustBelow().catch(() => void 0) : Promise.resolve(void 0);
  const resolved = resolveInput(input);
  const kind = originKind(input);
  let account;
  let resolvedVia = "account";
  let focus;
  let foundBy;
  const byOrigin = async () => {
    if (!origins) throw new Error("origin-chain transaction hashes are not searchable here; paste the NEAR transaction or the order account");
    const r = await findOrderByOrigin(input, client, origins);
    if ("notFound" in r) throw new Error(r.notFound);
    resolvedVia = "origin";
    foundBy = { chain: r.chain, originTx: r.originTx, ...r.depositTx ? { depositTx: r.depositTx } : {}, ...r.via ? { via: r.via } : {} };
    return r.account;
  };
  if (resolved.kind === "unsupported") {
    if (kind !== "evm" && kind !== "solana") throw new Error(resolved.reason);
    account = await byOrigin();
  } else if (resolved.kind === "tx") {
    let tx = (await client.transactions([resolved.hash]))[0];
    resolvedVia = "transaction";
    if (!tx && client.receiptTx) {
      tx = await client.receiptTx(resolved.hash) ?? void 0;
      resolvedVia = "receipt";
    }
    if (!tx) throw new Error(`${resolved.hash} is neither a transaction nor a receipt on NEAR`);
    focus = tx.hash;
    const found = findOrderAccount(tx);
    if (!found && tx.pendingReceipts) throw new Error(`transaction ${tx.hash} is still executing on NEAR: check again in a minute`);
    if (!found) throw new Error(`transaction ${tx.hash} carries no NEAR Intents order (no deposit, swap or withdrawal on intents.near)`);
    account = found;
  } else account = resolved.account;
  const seen = /* @__PURE__ */ new Set();
  let history = (await client.accountTxs(account)).filter((t) => !seen.has(t.hash) && seen.add(t.hash) !== void 0);
  if (history.length === 0 && kind === "hex64" && origins && resolvedVia === "account") {
    account = await byOrigin();
    history = (await client.accountTxs(account)).filter((t) => !seen.has(t.hash) && seen.add(t.hash) !== void 0);
  }
  if (history.length === 0 && resolvedVia === "account" && ETH_LIKE.test(account)) {
    throw new Error(`${account} has no NEAR Intents history. If it is your EVM wallet or a 1Click deposit address, paste your deposit transaction instead.`);
  }
  const txs = [];
  for (let i = 0; i < history.length; i += 20) txs.push(...await client.transactions(history.slice(i, i + 20).map((t) => t.hash)));
  const dustBelow = await dusting;
  const focusTx = resolvedVia === "transaction" || resolvedVia === "receipt" ? focus : foundBy?.depositTx;
  const report = traceOrder({ account, txs, nowNs, params: dustBelow ? { ...params, dustBelow } : params, ...focusTx ? { focusTx } : {} });
  const lastWithdrawal = payingWithdrawal(report);
  const executing = report.flags.some((f) => f.kind === "executing");
  const several = report.flags.some((f) => f.kind === "several_orders");
  const skipReason = executing ? "a transaction is still executing" : several ? "this account held several orders, and intents.near shows only what they left together" : null;
  const chainBalances = client.intentsBalances && skipReason === null ? client.intentsBalances(account).catch(() => null) : null;
  if (payouts && !executing && lastWithdrawal && report.payout.status === "unverified" && lastWithdrawal.bridge !== "near") {
    report.payout = await searchPayout(lastWithdrawal, payouts, nowNs);
    if (report.payout.status === "not_found") {
      report.flags.push({ kind: "payout_not_found", waitedSec: report.payout.waitedSec, detail: "no transfer of about the withdrawn amount reached the destination address" });
    }
  }
  const p = report.payout;
  if (client.accountExists && !executing && p.status === "arrived" && p.bridge === "near" && p.via !== "transfer" && lastWithdrawal?.kind !== "native_withdraw" && p.destination && claimableName(p.destination)) {
    if (await client.accountExists(p.destination).catch(() => null) === false) report.flags.push(destinationMissing(p.destination));
  }
  let checked;
  if (client.intentsBalances) {
    if (chainBalances === null) checked = { status: "not_verified", reason: skipReason ?? "intents.near's balances could not be read now" };
    else {
      const { check, flag } = balanceCheck(report.balances, await chainBalances);
      checked = check;
      if (flag) report.flags.push(flag);
    }
  }
  return { ...report, resolvedFrom: resolved, resolvedVia, ...foundBy ? { foundBy } : {}, txCount: txs.length, ...checked ? { balanceCheck: checked } : {} };
}
async function searchPayout(w, payouts, nowNs) {
  const base = { chain: w.chain, bridge: w.bridge, destination: w.destination };
  const ask = () => {
    if (!w.tx) return null;
    if (w.bridge === "poa" && payouts.bridgeWithdrawal) return payouts.bridgeWithdrawal(w.tx, w.token);
    if (w.bridge === "omni" && payouts.omniTransfer) return payouts.omniTransfer(w.tx, w.token, w.amount);
    if (w.bridge === "hot" && payouts.hotWithdrawal) return payouts.hotWithdrawal(w.tx);
    return null;
  };
  const asking = (ask() ?? Promise.resolve(null)).catch(() => null);
  const recorded = async (report2) => {
    const nonce = report2?.destinationNonce;
    if (report2?.source !== "omni" || report2.tx || report2.fastTx || nonce === void 0 || !w.chain || !payouts.omniPaid) return null;
    if (await payouts.omniPaid(w.chain, nonce).catch(() => null) !== true) return null;
    return { status: "arrived", how: "recorded", ...base, tx: null, amount: null, delaySec: null, confirmed: true, destinationNonce: nonce, bridgeReport: report2 };
  };
  if (w.chain === "zec") return zcashPayout(w, await asking, payouts, base, nowNs);
  const target = payoutTarget(w);
  if ("unsupported" in target) {
    const report2 = await asking;
    return await recorded(report2) ?? { status: "unverified", ...base, ...report2 ? { bridgeReport: report2 } : {}, reason: target.unsupported };
  }
  const [read, report] = await Promise.all([payouts.incoming(target).then((page2) => ({ page: page2 }), (error) => ({ error })), asking]);
  let page = "page" in read ? read.page : { items: [], complete: false };
  for (const named of [report?.fastTx, report?.tx]) {
    if (!named || !payouts.payoutTx) continue;
    if (page.items.some((x) => x.tx.toLowerCase() === named.toLowerCase())) break;
    const found = await payouts.payoutTx(target, named).catch(() => null);
    if (found) {
      page = { ...page, items: [...page.items, found] };
      break;
    }
  }
  if ("error" in read && page.items.length === 0) {
    const e = read.error;
    return await recorded(report) ?? { status: "unverified", ...base, ...report ? { bridgeReport: report } : {}, reason: `could not read ${target.chain}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const matched = matchPayout(target, page, Number(nowNs / 1000000000n), base, report);
  return matched.status === "arrived" || matched.status === "missing" ? matched : await recorded(report) ?? matched;
}
var ZEC_FEES_MAX = 1010000n;
async function zcashPayout(w, report, payouts, base, nowNs) {
  const b = report ? { ...base, bridgeReport: report } : base;
  const waitedSec = w.timestampNs === null ? null : Number((nowNs - w.timestampNs) / 1000000000n);
  if (report && !report.tx && waitedSec !== null && waitedSec < expectedWithinSec("zec")) return { status: "waiting", ...b, waitedSec };
  if (!report?.tx) return { status: "unverified", ...b, reason: report ? "the bridge does not name a Zcash transaction for it yet" : "payouts on zec are read from the transaction the bridge names, and the bridge does not know this withdrawal" };
  if (!payouts.zcashTx) return { status: "unverified", ...b, reason: "payouts on zec are not searched yet" };
  let z;
  try {
    z = await payouts.zcashTx(report.tx);
  } catch (e) {
    return { status: "unverified", ...b, reason: `could not read zec: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!z) return { status: "unverified", ...b, reason: "the Zcash transaction the bridge names is not on the Zcash chain" };
  const burnSec = w.timestampNs === null ? null : Number(w.timestampNs / 1000000000n);
  const delaySec = z.confirmedAtSec !== null && burnSec !== null ? z.confirmedAtSec - burnSec : null;
  const named = (w.destination ?? "").replace(/^zcash:/, "");
  const address = texToTransparent(named) ?? named;
  const paidOpenly = z.outputs.filter((o) => o.address === address).reduce((s, o) => s + o.valueZat, 0n);
  if (paidOpenly > 0n) return { status: "arrived", how: "confirmed", ...b, tx: report.tx, amount: paidOpenly.toString(), delaySec, confirmed: z.confirmedAtSec !== null };
  const shielded = z.shieldedIn.reduce((s, p) => s + p.zat, 0n);
  const withdrawn = BigInt(w.amount);
  if (shielded > 0n && !address.startsWith("t") && shielded <= withdrawn && shielded >= withdrawn - ZEC_FEES_MAX) {
    return { status: "arrived", how: "shielded", ...b, tx: report.tx, amount: shielded.toString(), delaySec, confirmed: z.confirmedAtSec !== null, shieldedPool: z.shieldedIn.map((p) => p.pool).join(" and ") };
  }
  return {
    status: "unverified",
    ...b,
    reason: shielded > 0n ? "the Zcash transaction the bridge names moved a different amount into the shielded pool than this withdrawal (it may pay several transfers)" : "the Zcash transaction the bridge names pays nothing visible to this address"
  };
}
var FASTNEAR_TX_API = "https://tx.main.fastnear.com";
var MAX_HISTORY_PAGES = 3;
var RATE_LIMIT_WAITS_MS = [1e3, 2e3, 4e3];
var MAX_RETRY_AFTER_MS = 1e4;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fastnearClient(fetchImpl = fetch, base = FASTNEAR_TX_API, wait = sleep, views = nearViews(fetchImpl)) {
  async function post2(path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const backoff = RATE_LIMIT_WAITS_MS[attempt];
      if (res.status === 429 && backoff !== void 0) {
        const after = Number(res.headers.get("retry-after"));
        await wait(Number.isFinite(after) && after > 0 ? Math.min(after * 1e3, MAX_RETRY_AFTER_MS) : backoff);
        continue;
      }
      if (!res.ok) throw new Error(`FastNEAR ${path}: HTTP ${res.status}`);
      return parseFastnearJson(await res.text());
    }
  }
  return {
    ...views,
    async accountTxs(account) {
      const out = [];
      let resumeToken;
      let total;
      for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
        const r = await post2("/v0/account", { account_id: account, limit: 200, desc: false, ...resumeToken ? { resume_token: resumeToken } : {} });
        for (const t of r.account_txs) out.push({ hash: t.transaction_hash, height: t.tx_block_height, timestampNs: BigInt(String(t.tx_block_timestamp)) });
        total = r.txs_count ?? total;
        resumeToken = r.resume_token;
        if (!resumeToken) return out;
      }
      throw new Error(`${account} has ${total ?? `more than ${out.length}`} transactions: that is a wallet account, not one swap. Paste the swap's NEAR transaction or your deposit transaction instead.`);
    },
    async transactions(hashes) {
      if (hashes.length === 0) return [];
      const r = await post2("/v0/transactions", { tx_hashes: hashes });
      return r.transactions.filter((t) => t && t.transaction).map(decodeFastnearTx);
    },
    async blockTime(height) {
      const r = await post2("/v0/block", { block_id: height });
      const ts = r.block?.block_timestamp;
      return ts === void 0 ? null : Number(BigInt(String(ts)) / 1000000000n);
    },
    async latestTx(account) {
      const r = await post2("/v0/account", { account_id: account, limit: 1, desc: true });
      const t = r.account_txs[0];
      return t ? { height: t.tx_block_height, timeSec: Number(BigInt(String(t.tx_block_timestamp)) / 1000000000n) } : null;
    },
    async recentTxs(account, limit) {
      const r = await post2("/v0/account", { account_id: account, desc: true, limit: Math.min(200, limit) });
      return r.account_txs.map((t) => ({ hash: t.transaction_hash, height: t.tx_block_height, timestampNs: BigInt(String(t.tx_block_timestamp)) }));
    },
    async accountTxsBetween(account, fromHeight, toHeight, limit) {
      const out = [];
      let resumeToken;
      while (out.length < limit) {
        const r = await post2("/v0/account", {
          account_id: account,
          desc: false,
          limit: Math.min(200, limit - out.length),
          from_tx_block_height: fromHeight,
          to_tx_block_height: toHeight,
          ...resumeToken ? { resume_token: resumeToken } : {}
        });
        for (const t of r.account_txs) out.push({ hash: t.transaction_hash, height: t.tx_block_height, timestampNs: BigInt(String(t.tx_block_timestamp)) });
        resumeToken = r.resume_token;
        if (!resumeToken || r.account_txs.length === 0) break;
      }
      return out;
    },
    async receiptTx(receiptId) {
      const r = await post2("/v0/receipt", { receipt_id: receiptId });
      return r.transaction && r.transaction.transaction ? decodeFastnearTx(r.transaction) : null;
    }
  };
}
export {
  EVM_RPC,
  checkOrder,
  checkOrderWithFallback,
  fastnearClient,
  fastnearUnavailable,
  payingWithdrawal,
  publicOriginClient,
  publicPayoutClient,
  searchPayout
};
