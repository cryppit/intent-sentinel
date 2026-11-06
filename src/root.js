// Each day's verdicts as one RFC 6962 Merkle root (the tree in ADR 0026), so a root pinned on NEAR proves a packet existed
// unchanged that day. This file builds and checks; it never signs. Leaves are verdict hashes, sorted, each counted once.
import { postJson } from "./net.js";

const HEX64 = /^[0-9a-f]{64}$/;
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const RPC = { mainnet: "https://rpc.mainnet.fastnear.com", testnet: "https://rpc.testnet.fastnear.com" };

const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha(...parts) {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}
const leafHash = (leaf) => sha(new Uint8Array([0]), leaf);
const nodeHash = (l, r) => sha(new Uint8Array([1]), l, r);

function split(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function leaves(hashes) {
  for (const h of hashes) if (!HEX64.test(h)) throw new Error(`root: ${h} is not 64 lowercase hex`);
  return [...new Set(hashes)].sort();
}

async function tree(nodes) {
  if (nodes.length === 1) return nodes[0];
  const k = split(nodes.length);
  return nodeHash(await tree(nodes.slice(0, k)), await tree(nodes.slice(k)));
}

export async function dayRoot(hashes) {
  const sorted = leaves(hashes);
  if (!sorted.length) return { root: EMPTY, leafCount: 0 };
  const nodes = await Promise.all(sorted.map((h) => leafHash(bytes(h))));
  return { root: hex(await tree(nodes)), leafCount: sorted.length };
}

async function path(nodes, index) {
  if (nodes.length === 1) return [];
  const k = split(nodes.length);
  return index < k
    ? [...(await path(nodes.slice(0, k), index)), await tree(nodes.slice(k))]
    : [...(await path(nodes.slice(k), index - k)), await tree(nodes.slice(0, k))];
}

export async function proofFor(hashes, hash) {
  const sorted = leaves(hashes);
  const index = sorted.indexOf(hash);
  if (index < 0) throw new Error("root: that verdict is not in this day");
  const nodes = await Promise.all(sorted.map((h) => leafHash(bytes(h))));
  return { index, size: sorted.length, path: (await path(nodes, index)).map(hex) };
}

/** RFC 9162 section 2.1.3.2. */
export async function verifyProof(hash, proof, root) {
  let fn = proof.index;
  let sn = proof.size - 1;
  let r = await leafHash(bytes(hash));
  for (const step of proof.path.map(bytes)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = await nodeHash(step, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = await nodeHash(r, step);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && hex(r) === root;
}

export function pinArgs(day, hashes, root, leafCount, prevPin) {
  return { day, head_hash: leaves(hashes).at(-1) ?? EMPTY, merkle_root: root, leaf_count: leafCount, prev_pin: prevPin };
}

export function nearCommand(account, args, network) {
  return `near contract call-function as-transaction ${account} pin json-args '${JSON.stringify(args)}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as ${account} network-config ${network} sign-with-keychain send`;
}

async function readPin(account, day, network, ctx) {
  const args = btoa(JSON.stringify({ day }));
  const r = await postJson(RPC[network], { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: account, method_name: "get_pin", args_base64: args } }, ctx);
  return JSON.parse(String.fromCharCode(...r.result.result));
}

/** Reads the pin with a public view call and checks the proof against it. */
export async function checkPin(hash, proof, account, day, network, ctx = {}) {
  const pin = await readPin(account, day, network, ctx);
  if (!pin) return { ok: false, reason: `no pin for ${day} on ${account}` };
  const ok = await verifyProof(hash, proof, pin.merkle_root);
  return { ok, pin, reason: ok ? "the verdict is in the pinned root" : "the proof does not match the pinned root" };
}
