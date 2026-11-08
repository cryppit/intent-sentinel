import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const code = [...readdirSync("src").filter((f) => f.endsWith(".js")).map((f) => `src/${f}`), ...readdirSync("src/adapters").map((f) => `src/adapters/${f}`), "vendor/wms-core.mjs"].map((f) => readFileSync(f, "utf8")).join("\n");
const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
const connect = csp.split(";").find((d) => d.trim().startsWith("connect-src")) ?? "";

test("the page has a CSP, no referrer, no analytics, no storage", () => {
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /no-referrer/);
  assert.doesNotMatch(html + readFileSync("src/page.js", "utf8"), /localStorage|sessionStorage|gtag|plausible|googletagmanager/);
});
test("scripts come only from this site", () => {
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
});
test("no wildcard in connect-src", () => assert.doesNotMatch(connect, /\*|https:(\s|$)/));
test("every host the code calls is allowed", () => {
  const hosts = new Set([...code.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/g)].map((m) => m[1]));
  for (const skip of ["github.com", "docs.near.org", "www.w3.org", "nearblocks.io", "etherscan.io", "solscan.io", "basescan.org", "arbiscan.io", "bscscan.com", "tronscan.org", "explorer.testnet.near.org", "explorer.near.org",
    // A docs link the tracer cites, never fetched; and the testnet RPC that only the command line's verify calls.
    "docs.near-intents.org", "rpc.testnet.fastnear.com",
    // This site itself, named in the frame message: 'self' covers it.
    "cryppit.github.io"]) hosts.delete(skip);
  for (const h of hosts) assert.ok(connect.includes(`https://${h}`), `${h} is missing from connect-src`);
});
test("connect-src has no host the page never calls", () => {
  // A docs link in the tracer, and the testnet RPC only the command line's verify uses.
  for (const h of ["docs.near-intents.org", "rpc.testnet.fastnear.com"]) assert.ok(!connect.includes(`https://${h}`), h);
});
test("the privacy note says exactly who sees what you paste", () => {
  const note = /<section class="sec" id="privacy">([\s\S]*?)<\/section>/.exec(html)[1];
  assert.match(note, /Any address you paste/);
  assert.match(note, /1Click/);
  assert.match(note, /\.near/);
  assert.match(note, /IP address/);
  assert.match(note, /this site/);
  assert.match(note, /community/);
  assert.match(note, /bridge\.chaindefuser\.com/);
  assert.doesNotMatch(note, /doesn't tell other sites where you came from/);
});
