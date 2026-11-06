// Records a case from public chain data: node scripts/record.mjs <name> <identifier>
// It refuses anything from 1Click, whose terms don't allow keeping its data. Review the result by hand before committing.
import { mkdirSync, writeFileSync } from "node:fs";
import { openCase } from "../src/case.js";

const [name, id] = process.argv.slice(2);
if (!name || !id) throw new Error("usage: node scripts/record.mjs <name> <identifier>");
const r = await openCase(id, { now: new Date().toISOString(), adapters: { status: async () => null } });
if (r.error) throw new Error(r.error);
if (r.caseData.claims.some((c) => c.by === "1click")) throw new Error("refusing to record 1Click data");
mkdirSync(`fixtures/${name}`, { recursive: true });
writeFileSync(`fixtures/${name}/case.json`, `${JSON.stringify(r.caseData, null, 2)}\n`);
writeFileSync(`fixtures/${name}/expected.json`, `${JSON.stringify(r.verdict, null, 2)}\n`);
console.log(name, r.verdict.journey, "next:", r.verdict.nextAction.party, "|", r.verdict.legs.map((l) => `${l.provider}:${l.status}:${l.class}`).join(" > "));
