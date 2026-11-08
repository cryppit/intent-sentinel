import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { wheelChains } from "../src/words.js";
import { LATEST_PIN, pinUrl } from "../src/pins.js";
import { packetHash } from "../src/packet.js";
import { dayRoot } from "../src/root.js";

test("the wheel shows each blockchain once, NEAR first, every one with a logo file", () => {
  const chains = wheelChains();
  const names = chains.map((c) => c.name);
  assert.equal(names[0], "NEAR");
  assert.equal(new Set(names).size, names.length);
  for (const c of chains) assert.ok(existsSync(`logos/${c.logo}.svg`), c.logo);
});

test("the wheel shows blockchains only, not services or bridges", () => {
  const names = wheelChains().map((c) => c.name);
  for (const service of ["NEAR Intents", "NEAR Intents balance check", "Omni bridge", "1Click", "Unknown blockchain"]) assert.ok(!names.includes(service), service);
});

test("the wheel counts 31 blockchains today", () => assert.equal(wheelChains().length, 31));

test("the pin badge names the root of the packets saved for that day", async () => {
  const dir = `pins/${LATEST_PIN.day}`;
  const hashes = await Promise.all(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => packetHash(JSON.parse(readFileSync(`${dir}/${f}`, "utf8")))));
  assert.equal((await dayRoot(hashes)).root, LATEST_PIN.root);
  assert.equal(LATEST_PIN.account, "sentinel.cryppit.testnet");
  assert.equal(LATEST_PIN.network, "testnet");
});

test("the pin badge links to the pin transaction on NEAR's testnet explorer", () =>
  assert.equal(pinUrl(LATEST_PIN), "https://explorer.testnet.near.org/transactions/GW6MLNNSiztTC11haCkzyK2wy62JwtRKsu2zbh6gdAi9"));

test("the page has the wheel and the pin badge", () => {
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /id="wheel"/);
  assert.match(html, /id="pin-badge"/);
});

test("the help line under an Omni relayer adds something, instead of repeating 'the bridge's operator'", () => {
  const code = readFileSync("src/page.js", "utf8");
  assert.doesNotMatch(code, /"omni-relayer": "[^"]*bridge's operator/);
});

test("a slim chain strip under the headline leads down to the wheel", () => {
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /<a class="strip" id="chain-strip" href="#reach"/);
  assert.match(html, /<section class="reach" id="reach"/);
});

test("the wheel's middle says why NEAR is there", () => {
  const code = readFileSync("src/page.js", "utf8");
  assert.match(code, /"where swaps settle"/);
});
