#!/usr/bin/env node
// Intent Sentinel. Exit codes let an agent gate on the answer: 0 nothing to do, 2 someone must act, 3 not enough
// evidence, 1 bad input.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openCase, replayCase } from "./src/case.js";
import { buildPacket, packetHash, verifyPacket } from "./src/packet.js";
import { exitCode, renderText } from "./src/render-text.js";
import { checkPin, dayRoot, nearCommand, pinArgs, proofFor } from "./src/root.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `Usage:
  node cli.js check <hash, address or Omni id> [--json]   read a case from public chains
  node cli.js replay <name> [--json]                      replay a recorded case, no network
  node cli.js demo                                        list the recorded cases
  node cli.js root <folder> --day YYYY-MM-DD [--account a.testnet] [--prev YYYY-MM-DD] [--network testnet]
                                                          Merkle root of a folder of packets, and the command to pin it
  node cli.js prove <folder> <packet name>                a proof that a packet is in that root
  node cli.js verify <packet.json> <proof.json> --account a.testnet --day YYYY-MM-DD [--network testnet]
                                                          check a packet against the pin on NEAR, by a public view call`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function finish({ caseData, verdict }, json) {
  console.log(json ? JSON.stringify(buildPacket(caseData, verdict), null, 2) : renderText(verdict));
  process.exit(exitCode({ verdict }));
}

/** Packets from a folder: downloaded packet files, and recorded cases rebuilt from their case.json. */
async function packetsIn(folder) {
  const packets = new Map();
  if (!existsSync(folder)) fail(`No folder called ${folder}.`);
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) {
      if (!existsSync(join(path, "case.json"))) continue;
      const { caseData, verdict } = await replayCase(path);
      packets.set(name, buildPacket(caseData, verdict));
    } else if (name.endsWith(".json")) {
      const packet = JSON.parse(readFileSync(path, "utf8"));
      if (!packet.verdict) continue;
      if (!(await verifyPacket(packet))) fail(`${name}: its verdict doesn't match its hash, so it was changed.`);
      packets.set(name.replace(/\.json$/, ""), packet);
    }
  }
  return packets;
}

const hashesOf = async (packets) => Promise.all([...packets.values()].map(packetHash));

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  return argv.splice(i, 2)[1] ?? null;
};
const day = flag("--day");
const account = flag("--account");
const prev = flag("--prev");
const network = flag("--network") ?? "testnet";
const args = argv;
const json = args.includes("--json");
const [command, target, extra] = args.filter((a) => a !== "--json");

if (command === "demo") {
  for (const name of readdirSync(join(HERE, "fixtures")).sort()) console.log(name);
} else if (command === "replay" && target) {
  const dir = join(HERE, "fixtures", target);
  if (!/^[a-z0-9-]+$/.test(target) || !existsSync(dir)) fail(`No recorded case called ${target}. Run: node cli.js demo`);
  finish(await replayCase(dir), json);
} else if (command === "check" && target) {
  const r = await openCase(target, { now: new Date().toISOString() });
  if (r.error && !r.notice) fail(r.error);
  if (r.error) {
    console.log(json ? JSON.stringify({ notice: r.error }, null, 2) : r.error);
    process.exit(exitCode(r));
  }
  finish(r, json);
} else if (command === "root" && target) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) fail("root needs --day YYYY-MM-DD: a closed UTC day.");
  const hashes = await hashesOf(await packetsIn(target));
  const { root, leafCount } = await dayRoot(hashes);
  console.log(`day ${day}\nleaves ${leafCount}\nroot ${root}`);
  if (account) console.log(`\nPin it yourself. This tool never signs:\n${nearCommand(account, pinArgs(day, hashes, root, leafCount, prev), network)}`);
} else if (command === "prove" && target && extra) {
  const packets = await packetsIn(target);
  const packet = packets.get(extra);
  if (!packet) fail(`No packet called ${extra} in ${target}.`);
  console.log(JSON.stringify(await proofFor(await hashesOf(packets), await packetHash(packet)), null, 2));
} else if (command === "verify" && target && extra && account && day) {
  const packet = JSON.parse(readFileSync(target, "utf8"));
  if (!(await verifyPacket(packet))) fail("This packet's verdict doesn't match its hash, so it was changed.");
  const r = await checkPin(await packetHash(packet), JSON.parse(readFileSync(extra, "utf8")), account, day, network).catch((e) => ({ ok: false, reason: `Could not read the pin: ${e.message}` }));
  console.log(r.reason);
  process.exit(r.ok ? 0 : 3);
} else {
  fail(USAGE);
}
