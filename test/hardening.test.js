// Security audit, 8 Nov 2026: framing, prototype keys, terminal escapes, the HTTP cache and the publish workflow.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { framed } from "../src/frame-guard.js";
import { place, placeName } from "../src/words.js";
import { explorerUrl } from "../src/render-case.js";
import { printable, renderText } from "../src/render-text.js";
import { getJson, postJson, postJsonOnce } from "../src/net.js";
import { readOrder } from "../src/adapters/near.js";
import { payoutSide } from "../src/adapters/payout-side.js";

test("the page knows when another site frames it", () => {
  const w = {};
  w.top = w;
  w.self = w;
  assert.equal(framed(w), false);
  assert.equal(framed({ top: {}, self: {} }), true);
  assert.equal(framed({ get top() { throw new Error("cross-origin"); }, self: {} }), true);
});
test("the page refuses to run inside a frame, before it does anything else", () => {
  const code = readFileSync("src/page.js", "utf8");
  const guard = code.indexOf("if (framed(window))");
  assert.ok(guard > 0, "no frame check in page.js");
  assert.ok(guard < code.indexOf("addEventListener"), "the frame check comes after the page starts");
  assert.match(code.slice(guard, guard + 400), /Open Intent Sentinel directly/);
});

for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
  test(`a chain called "${key}" is just an unknown name`, () => {
    assert.deepEqual(place(key), [key, null]);
    assert.equal(placeName(key), key);
    assert.equal(explorerUrl(key, "abc"), null);
  });
}

test("control characters from remote text never reach the terminal", () => {
  assert.equal(printable("a\u001b]52;c;ZXZpbA==\u0007b\u009b31mc\u0000d\ne\tf"), "a]52;c;ZXZpbA==b31mcd\ne\tf");
});
test("a warning carrying an escape sequence prints without it", () => {
  const verdict = { journey: "PAID_OUT", nextAction: { party: "none", question: null, evidenceToAsk: [] }, legs: [], claims: [], conservation: [], warnings: [{ kind: "x", detail: "evil\u001b[2Jname" }], incident: "iv1_" + "0".repeat(64), outputHash: "0".repeat(64) };
  const out = renderText(verdict);
  assert.doesNotMatch(out, /\u001b/);
  assert.match(out, /evil\[2Jname/);
});

/** A fetch that records each request's options and answers {} . */
const recorder = () => {
  const inits = [];
  return { inits, f: async (url, init = {}) => { inits.push(init); return Response.json({ result: null }); } };
};
test("the page's own reads ask the browser not to keep the answer", async () => {
  const { inits, f } = recorder();
  await getJson("https://example.org/x", { fetch: f });
  await postJson("https://example.org/x", {}, { fetch: f });
  await postJsonOnce("https://example.org/x", {}, { fetch: f });
  assert.ok(inits.length >= 3 && inits.every((i) => i.cache === "no-store"), JSON.stringify(inits.map((i) => i.cache)));
});
test("the tracer's reads ask the browser not to keep the answer", async () => {
  const { inits, f } = recorder();
  await readOrder("gnk-usd.near", { now: "2026-11-08T12:00:00Z", fetch: f, timeoutMs: 2000 });
  assert.ok(inits.length > 0 && inits.every((i) => i.cache === "no-store"), JSON.stringify(inits.map((i) => i.cache)));
});
test("the payout lookups ask the browser not to keep the answer", async () => {
  const { inits, f } = recorder();
  await payoutSide({ kind: "evm-tx", value: "0x" + "c".repeat(64) }, { fetch: f });
  assert.ok(inits.length > 0 && inits.every((i) => i.cache === "no-store"));
});

test("only the deploy job can publish; the build job reads the repo and keeps no token", () => {
  const yml = readFileSync(".github/workflows/pages.yml", "utf8");
  const [top, jobs] = yml.split(/^jobs:$/m);
  const [build, deploy] = jobs.split(/^  deploy:$/m);
  assert.doesNotMatch(top, /pages: write|id-token: write/);
  assert.match(build, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(build, /pages: write|id-token: write/);
  assert.match(build, /actions\/checkout@v4\n\s+with:\n\s+persist-credentials: false/);
  assert.match(deploy, /pages: write/);
  assert.match(deploy, /id-token: write/);
});
test("a fetch handed to the tracer's payout client also asks not to keep the answer", async () => {
  const { noStore } = await import("../src/net.js");
  const { inits, f } = recorder();
  await noStore(f)("https://example.org/x", { method: "POST" });
  assert.deepEqual(inits, [{ method: "POST", cache: "no-store" }]);
});
