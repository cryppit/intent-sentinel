#!/usr/bin/env node
// Intent Sentinel. Exit codes let an agent gate on the answer: 0 nothing to do, 2 someone must act, 3 not enough
// evidence, 1 bad input.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openCase, replayCase } from "./src/case.js";
import { buildPacket } from "./src/packet.js";
import { renderText } from "./src/render-text.js";
import { checkPin, dayRoot, nearCommand, pinArgs, proofFor } from "./src/root.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `Usage:
  node cli.js check <hash, address or Omni id> [--json]   read a case from public chains
  node cli.js replay <name> [--json]                      replay a recorded case, no network
  node cli.js demo                                        list the recorded cases
  node cli.js root <folder> --day YYYY-MM-DD [--account a.testnet] [--prev YYYY-MM-DD] [--network testnet]
                                                          Merkle root of a folder of verdicts, and the command to pin it
  node cli.js prove <folder> <verdict hash>               a proof that a verdict is in that root
  node cli.js verify <verdict hash> <proof.json> --account a.testnet --day YYYY-MM-DD [--network testnet]
                                                          check a proof against the pin on NEAR, by a public view call`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function finish({ caseData, verdict }, json) {
  console.log(json ? JSON.stringify(buildPacket(caseData, verdict), null, 2) : renderText(verdict));
  if (verdict.journey === "INSUFFICIENT_EVIDENCE") process.exit(3);
  process.exit(verdict.nextAction.party === "none" ? 0 : 2);
}

/** Verdict hashes from a folder of packets or verdicts, including recorded cases' expected.json. */
function verdictHashes(folder) {
  const files = readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return existsSync(join(path, "expected.json")) ? [join(path, "expected.json")] : [];
    return name.endsWith(".json") ? [path] : [];
  });
  return files.map((f) => JSON.parse(readFileSync(f, "utf8"))).map((j) => j.outputHash ?? j.verdict?.outputHash).filter(Boolean);
}

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
  if (r.error) fail(r.error);
  finish(r, json);
} else if (command === "root" && target) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) fail("root needs --day YYYY-MM-DD: a closed UTC day.");
  const hashes = verdictHashes(target);
  const { root, leafCount } = await dayRoot(hashes);
  console.log(`day ${day}\nleaves ${leafCount}\nroot ${root}`);
  if (account) console.log(`\nPin it yourself. This tool never signs:\n${nearCommand(account, pinArgs(day, hashes, root, leafCount, prev), network)}`);
} else if (command === "prove" && target && extra) {
  console.log(JSON.stringify(await proofFor(verdictHashes(target), extra), null, 2));
} else if (command === "verify" && target && extra && account && day) {
  const r = await checkPin(target, JSON.parse(readFileSync(extra, "utf8")), account, day, network);
  console.log(r.reason);
  process.exit(r.ok ? 0 : 3);
} else {
  fail(USAGE);
}
