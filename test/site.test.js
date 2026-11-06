import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const code = readFileSync("src/page.js", "utf8");
const publish = readFileSync(".github/workflows/pages.yml", "utf8").match(/cp -r ([^\n]+) _site/)[1].split(/\s+/);

test("every folder the page loads from is published", () => {
  const used = new Set([...`${html}\n${code}`.matchAll(/(?:src="|href="|url\(|`)(logos|art|icons|src|fixtures)\//g)].map((m) => m[1]));
  for (const folder of [...used, "vendor"]) assert.ok(publish.includes(folder), `${folder} is not in the publish step`);
});

test("every file the page names exists", () => {
  for (const [, file] of html.matchAll(/(?:src="|href="|url\()((?:logos|art|icons|src)\/[^")]+)/g)) assert.ok(existsSync(file), file);
});

test("each recorded case on the page has a fixture", () => {
  for (const [, name] of html.matchAll(/data-(?:case|open)="([^"]+)"/g)) assert.ok(existsSync(`fixtures/${name}/case.json`), name);
});

test("the page only offers parties the rules can name", async () => {
  const { stageView } = await import("../src/stage.js");
  const board = stageView({ legs: [] }, { journey: "x", nextAction: { party: "none" } }).parties.map((p) => p.key);
  assert.ok(!board.includes("solver"));
  assert.doesNotMatch(html, /Solver/);
});
