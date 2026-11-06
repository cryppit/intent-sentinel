// Rewrites a recorded case's expected verdict after an intended rules change. Review the diff.
import { readdirSync, writeFileSync } from "node:fs";
import { replayCase } from "../src/case.js";

for (const name of readdirSync("fixtures")) {
  const { verdict } = await replayCase(`fixtures/${name}`);
  writeFileSync(`fixtures/${name}/expected.json`, `${JSON.stringify(verdict, null, 2)}\n`);
}
