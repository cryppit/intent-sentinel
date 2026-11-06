#!/usr/bin/env node
// Intent Sentinel. Exit codes let an agent gate on the answer: 0 nothing to do, 2 someone must act, 3 not enough
// evidence, 1 bad input.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openCase, replayCase } from "./src/case.js";
import { buildPacket } from "./src/packet.js";
import { renderText } from "./src/render-text.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `Usage:
  node cli.js check <hash, address or Omni id> [--json]   read a case from public chains
  node cli.js replay <name> [--json]                      replay a recorded case, no network
  node cli.js demo                                        list the recorded cases`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function finish({ caseData, verdict }, json) {
  console.log(json ? JSON.stringify(buildPacket(caseData, verdict), null, 2) : renderText(verdict));
  if (verdict.journey === "INSUFFICIENT_EVIDENCE") process.exit(3);
  process.exit(verdict.nextAction.party === "none" ? 0 : 2);
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const [command, target] = args.filter((a) => a !== "--json");

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
} else {
  fail(USAGE);
}
