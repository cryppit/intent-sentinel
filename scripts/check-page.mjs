// Drives real Chrome over the DevTools protocol and checks the page itself. Usage: node scripts/check-page.mjs [--live] [--shots dir]
// Needs the site served on BASE (default http://127.0.0.1:5079). No dependencies.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:5079/";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const live = process.argv.includes("--live");
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const PORT = 9333;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "sentinel-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 50 && !target; i++) {
  await wait(200);
  target = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const problems = [];
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) return pending.get(m.id)?.(m), pending.delete(m.id);
  if (m.method === "Runtime.exceptionThrown") problems.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/.test(m.params.entry.url ?? "")) problems.push(`console: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
};
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(`${expression}: ${r.result.exceptionDetails.exception?.description}`);
  return r.result.result.value;
};
const size = (width, height, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
const shot = async (name, full = false) => {
  if (!shots) return;
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(r.result.data, "base64"));
};
const load = async (hash = "") => { await send("Page.navigate", { url: BASE + hash }); await wait(1200); };

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`); if (!ok) failures++; };
const noOverflow = () => js("document.documentElement.scrollWidth <= innerWidth");
const text = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ""`);
const stops = () => js(`[...document.querySelectorAll('#track .stop')].map(s=>s.className.replace('stop ','')+':'+s.querySelector('b').innerText).join(' | ')`);
const lit = () => js(`[...document.querySelectorAll('.party.lit')].map(p=>p.innerText).join(',')`);
const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);

await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");

const CASES = [
  ["omni-665", "here:Omni bridge", "Omni relayer", "Next to act: an Omni relayer."],
  ["omni-666", "here:Omni bridge", "Omni relayer", "Next to act: an Omni relayer."],
  ["refund-5btc", "passed:Bitcoin", "Nobody", "Nobody needs to act"],
];
for (const [w, h, label] of [[1280, 900, "desktop"], [1920, 1080, "wide"], [820, 1100, "tablet"], [390, 844, "phone"], [340, 700, "small phone"]]) {
  await size(w, h, w < 800);
  await load();
  await wait(2200);
  check(`${label}: no sideways scroll`, await noOverflow());
  check(`${label}: first case drawn`, (await stops()).includes("here:Omni bridge"), await stops());
  await shot(`${label}-top`);
  for (const [name, stop, who, head] of CASES) {
    await click(`#stage [data-case="${name}"]`);
    await wait(2600);
    check(`${label} ${name}: stop`, (await stops()).includes(stop), await stops());
    check(`${label} ${name}: lit party`, (await lit()) === who, await lit());
    check(`${label} ${name}: answer`, (await text("#answer")).includes(head));
    check(`${label} ${name}: case file`, (await text("#out .verdict")).includes(head) && !(await js("document.getElementById('out').hidden")));
    check(`${label} ${name}: no sideways scroll`, await noOverflow());
    if (w >= 800) check(`${label} ${name}: beam drawn`, await js("!!document.querySelector('#beam path')"));
    await shot(`${label}-${name}`, true);
  }
  await load("#explained");
  check(`${label}: explained opens`, await js("!document.getElementById('view-explained').hidden && document.getElementById('view-check').hidden"));
  check(`${label}: explained no sideways scroll`, await noOverflow());
  await shot(`${label}-explained`, true);
}

await size(1280, 900);
await load();
check("demo plays by itself", (await text("#demo-toggle")) === "Pause demo");
await wait(8600);
check("demo moved to the next case", await js(`document.querySelector('#stage [data-case="omni-666"]').getAttribute('aria-pressed')==='true'`));
check("demo does not open a case file", await js("document.getElementById('out').hidden"));
check("demo does not scroll the page", (await js("scrollY")) === 0);
await click("#demo-toggle");
check("demo pauses", (await text("#demo-toggle")) === "Play demo");

await load("#limits");
check("a link into the guide opens the guide", await js("!document.getElementById('view-explained').hidden"));
await click('#view-explained [data-open="refund-5btc"]');
await wait(1500);
check("open this case returns to Check with the case file", (await js("!document.getElementById('view-check').hidden")) && (await text("#out .verdict")).includes("Nobody needs to act"));

await load();
for (const [input, want] of [["bc1hello", "doesn't look like"], ["foo:123", "doesn't look like"], ["alice.testnet", "testnet"]]) {
  await js(`document.getElementById('id').value=${JSON.stringify(input)};document.getElementById('form').requestSubmit()`);
  await wait(900);
  check(`bad input ${input} is refused in plain words`, (await text("#answer")).includes(want), await text("#answer"));
  check(`bad input ${input}: button comes back`, (await text("#go")) === "Open case →");
}

await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await load();
await wait(600);
check("reduced motion: the demo stays still", (await text("#demo-toggle")) === "Play demo");
check("reduced motion: no moving spark", await js("!document.querySelector('#beam .spark')"));
await send("Emulation.setEmulatedMedia", { features: [] });

if (live) {
  for (const [input, want] of [["Near:563761", "Nobody needs to act"], ["Near:563650", "Nobody needs to act"]]) {
    await js(`document.getElementById('id').value=${JSON.stringify(input)};document.getElementById('form').requestSubmit()`);
    for (let i = 0; i < 60 && (await text("#go")) !== "Open case →"; i++) await wait(1000);
    check(`live ${input}`, (await text("#answer")).includes(want), (await text("#answer")).replace(/\n/g, " / "));
    await wait(2600);
    await shot(`live-${input.replace(":", "-")}`);
  }
  await js(`document.getElementById('id').value="Near:563761";document.getElementById('form').requestSubmit()`);
  await wait(50);
  await click('#stage [data-case="omni-665"]');
  await wait(14000);
  check("a slow live read can't overwrite a demo clicked after it", (await text("#answer")).includes("Omni relayer"));
}

check("no script errors or blocked requests", problems.length === 0, problems.slice(0, 6).join(" ; "));
if (live) {
  await load();
  const sol = "3hd4Kzyd7VHQbNpgWamqznJtm9cTyAVhYVA751B8XUtPXQ4M1YpZBNx1gWnHuT1LEW11kttjRAK5geWRgKw7ppE5";
  await js(`document.getElementById('id').value=${JSON.stringify(sol)};document.getElementById('form').requestSubmit()`);
  for (let i = 0; i < 60 && (await text("#go")) !== "Open case →"; i++) await wait(1000);
  check("a Solana signature opens in the browser", (await text("#answer")).includes("Omni relayer"), (await text("#answer")).replace(/\n/g, " / "));
  await shot("live-solana", true);
}
ws.close(); chrome.kill(); await wait(300); rmSync(profile, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : "all page checks passed");
process.exit(failures ? 1 : 0);
