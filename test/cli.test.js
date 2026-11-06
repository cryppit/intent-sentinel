import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const run = (...args) => spawnSync("node", ["cli.js", ...args], { encoding: "utf8" });

test("replay prints who acts next and exits 2", () => {
  const r = run("replay", "omni-665");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Omni relayer/);
});
test("a finished case exits 0", () => assert.equal(run("replay", "refund-5btc").status, 0));
test("--json prints a packet an agent can read", () => {
  const p = JSON.parse(run("replay", "omni-665", "--json").stdout);
  assert.equal(p.verdict.journey, "GATED_FINISH");
  assert.ok(Array.isArray(p.timeline));
});
test("demo lists the cases", () => assert.match(run("demo").stdout, /omni-665[\s\S]*omni-666[\s\S]*refund-5btc/));
test("it runs from any folder", () => {
  const r = spawnSync("node", [`${process.cwd()}/cli.js`, "replay", "omni-665"], { encoding: "utf8", cwd: "/" });
  assert.equal(r.status, 2);
});
test("nonsense exits 1 with a plain sentence", () => {
  const r = run("check", "hello");
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /at .*\.js:\d+/);
});
test("an unknown case exits 1", () => assert.equal(run("replay", "nope").status, 1));
test("no command prints usage and exits 1", () => {
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /check/);
});
test("root prints the Merkle root and the command to pin it, and signs nothing", () => {
  const r = run("root", "fixtures", "--day", "2026-11-05", "--account", "sentinel.cryppit.testnet");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /root [0-9a-f]{64}/);
  assert.match(r.stdout, /leaves 3/);
  assert.match(r.stdout, /near contract call-function as-transaction sentinel\.cryppit\.testnet pin/);
});
test("root needs a day", () => assert.equal(run("root", "fixtures").status, 1));
test("prove gives a proof for a recorded verdict", () => {
  const { verdict } = JSON.parse(run("replay", "omni-665", "--json").stdout);
  const p = JSON.parse(run("prove", "fixtures", verdict.outputHash).stdout);
  assert.equal(p.size, 3);
  assert.ok(Array.isArray(p.path));
});
