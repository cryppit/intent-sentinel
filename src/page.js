// The page: a recorded case comes from fixtures/, a pasted id is read live from public chains in this browser.
import { openCase } from "./case.js";
import { buildPacket } from "./packet.js";
import { caseView, explorerUrl } from "./render-case.js";
import { placeName, stageView } from "./stage.js";
import { withDeadline } from "./net.js";
import { shortRef, wheelChains } from "./words.js";
import { LATEST_PIN, pinUrl } from "./pins.js";
import { buildVerdict } from "./verdict.js";

const $ = (id) => document.getElementById(id);
const out = $("out");
const track = $("track");
const board = $("board");
const answer = $("answer");
const rig = $("rig");
const beam = $("beam");
const stage = $("stage");
const toggle = $("demo-toggle");
const form = $("form");
const go = $("go");

const SVG = "http://www.w3.org/2000/svg";
const CASE_BUTTONS = [...document.querySelectorAll("#stage [data-case]")];
const CASES = CASE_BUTTONS.map((b) => b.dataset.case);
const CYCLE_MS = 8000;
const READ_LIMIT_MS = 90_000;
const calm = matchMedia("(prefers-reduced-motion: reduce)");
const narrow = matchMedia("(max-width: 760px)");

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}

function download(packet) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(packet, null, 2)], { type: "application/json" }));
  const a = el("a", { href: url, download: `${packet.verdict.incident.slice(0, 16)}.json` });
  a.click();
  URL.revokeObjectURL(url);
}

function coin(stop) {
  const bridge = /bridge/i.test(stop.name);
  const face = stop.logo
    ? el("img", { src: `logos/${stop.logo}.svg`, alt: "", width: 38, height: 38 })
    : el("span", { class: bridge ? "glyph" : "glyph-q" }, bridge ? "" : "?");
  return el("span", { class: "coin" }, face);
}

// Who a party is, in one line, shown under the headline. And where the money was last seen, in words.
const WHO_IS = {
  "omni-relayer": "You and your app can't run this step yourselves. It's the bridge's job.",
  "near-intents": "NEAR Intents is the NEAR service that holds your coins between the steps of a swap.",
  integrator: "Your app is the wallet or website you swapped through.",
  anyone: "This step is open: anyone, including you, can do it.",
};
const CUSTODY = { bridge: "with the bridge", "intents.near": "held by NEAR Intents", recipient: "at the receiving address", "refund address": "back at your refund address", "omni bridge": "with the Omni bridge" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayWords = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

const stamp = (stop) => (stop.class ? el("span", { class: `cls c-${stop.class.toLowerCase()}` }, stop.classLabel) : el("span", { class: "cls c-ahead" }, "Not reached"));

function stopNode(stop, i) {
  const node = el("li", { class: `stop ${stop.state}${stop.failed ? " failed" : ""}` }, coin(stop), el("b", {}, stop.name), el("span", { class: "lbl" }, stop.label), stamp(stop));
  node.style.setProperty("--i", i);
  return node;
}

function linkNode(next, i) {
  const kind = next.state === "ahead" ? "ahead" : next.class === "PROVEN" ? "lit" : "weak";
  const node = el("li", { class: `link ${kind}`, "aria-hidden": "true" });
  node.style.setProperty("--i", i);
  return node;
}

function partyNode(party) {
  const node = el("li", { class: `party p-${party.key}${party.lit ? " lit" : ""}` }, el("span", { class: "dot" }), party.name);
  if (party.lit) node.setAttribute("aria-current", "true");
  return node;
}

function drawBeam(animate) {
  beam.replaceChildren();
  if (narrow.matches || !rig.offsetParent) return;
  const stops = [...track.querySelectorAll(".stop")];
  const from = stops.find((s) => s.classList.contains("here")) ?? stops.filter((s) => s.classList.contains("passed")).at(-1);
  const to = board.querySelector(".lit");
  if (!from || !to) return;
  // Offsets, not screen rectangles: the stops are still sliding in when this runs.
  const x1 = track.offsetLeft + from.offsetLeft + from.offsetWidth / 2;
  const y1 = track.offsetTop + from.offsetTop + from.offsetHeight + 2;
  const x2 = board.offsetLeft + to.offsetLeft + to.offsetWidth / 2;
  const y2 = board.offsetTop + to.offsetTop - 2;
  const mid = (y1 + y2) / 2;
  const d = `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  path.setAttribute("pathLength", "1");
  path.setAttribute("class", animate && !calm.matches ? "ray draw" : "ray");
  path.style.setProperty("--n", stops.length);
  beam.append(path);
  if (calm.matches) return;
  const spark = document.createElementNS(SVG, "circle");
  spark.setAttribute("r", "4.5");
  spark.setAttribute("class", animate ? "spark late" : "spark");
  const move = document.createElementNS(SVG, "animateMotion");
  move.setAttribute("dur", "1.8s");
  move.setAttribute("repeatCount", "indefinite");
  move.setAttribute("path", d);
  spark.append(move);
  beam.append(spark);
}

function clearStage(tone) {
  track.replaceChildren();
  board.replaceChildren();
  beam.replaceChildren();
  rig.dataset.tone = tone;
  answer.dataset.tone = tone;
}

function drawStage(view, picked, caseId, openFile) {
  stage.classList.remove("reading");
  rig.dataset.tone = view.tone;
  const nodes = [];
  view.stops.forEach((s, i) => {
    if (i) nodes.push(linkNode(s, i));
    nodes.push(stopNode(s, i));
  });
  track.replaceChildren(...nodes);
  track.classList.toggle("many", view.stops.length > 6);
  rig.style.setProperty("--n", view.stops.length);
  board.replaceChildren(...view.parties.map(partyNode));
  const words = el("div", { class: "a-words" }, el("p", { class: "a-eyebrow" }, view.tone === "unknown" ? "No answer yet" : "Who acts next"), el("p", { class: "a-who" }, picked.headline));
  if (picked.question) words.append(el("p", { class: "a-q" }, picked.question));
  if (view.tone === "act" && WHO_IS[picked.party]) words.append(el("p", { class: "a-help" }, WHO_IS[picked.party]));
  if (view.custody) words.append(el("span", { class: "held" }, `Your money was last seen: ${CUSTODY[view.custody] ?? view.custody}`));
  const more = el("button", { type: "button", class: "a-more" }, "See the full case →");
  more.addEventListener("click", () => {
    setPlaying(false);
    if (caseId) return openRecorded(caseId, true);
    openFile();
    out.scrollIntoView({ block: "start" });
  });
  answer.replaceChildren(words, more);
  answer.dataset.tone = view.tone;
  for (const b of CASE_BUTTONS) b.setAttribute("aria-pressed", String(b.dataset.case === caseId));
  requestAnimationFrame(() => drawBeam(true));
}

function caseFile({ caseData, verdict }, view, stageData, note) {
  const packet = buildPacket(caseData, verdict);
  const head = el("div", { class: `verdict ${view.tone}` }, el("p", { class: "eyebrow" }, "Case file"), el("h2", {}, view.headline));
  if (view.question) head.append(el("p", { class: "question" }, view.question));
  if (view.ask.length) head.append(el("p", { class: "ask" }, el("b", {}, `${view.askWho}: `), `${view.ask.join("; ")}.`));
  if (view.youCan.length) head.append(el("p", { class: "ask" }, el("b", {}, "What you can do: "), `${view.youCan.join("; or ")}.`));
  if (note) head.append(el("p", { class: "note" }, note));

  const steps = el("ol", { class: "steps" });
  for (const s of stageData.stops.filter((x) => x.class)) {
    steps.append(el("li", { class: s.failed ? "failed" : "" }, coin(s), el("span", { class: "s-t" }, el("b", {}, s.name), el("span", {}, s.label)), stamp(s)));
  }
  const notes = el("ul", { class: "notes" });
  for (const w of view.warnings) notes.append(el("li", { class: "warn" }, w));
  for (const c of view.claims) notes.append(el("li", {}, c, " ", el("span", { class: "cls c-reported" }, "Reported")));
  for (const b of view.balances) notes.append(el("li", {}, b));

  const proof = el("ul", { class: "proof" });
  for (const t of packet.timeline) {
    const url = explorerUrl(t.source, t.ref);
    const ref = url ? el("a", { href: url, target: "_blank", rel: "noreferrer" }, shortRef(t.ref)) : el("span", {}, shortRef(t.ref));
    proof.append(el("li", {}, el("time", {}, t.at ? `${t.at.slice(0, 16).replace("T", " ")} UTC` : "No time on the blockchain record"), el("span", { class: "who" }, placeName(t.source)), ref));
  }

  const left = el("div", { class: "card" }, el("h3", {}, "What each step proves"), steps);
  if (notes.children.length) left.append(notes);
  const right = el("div", { class: "card" }, el("h3", {}, "Proof you can check yourself"));
  right.append(packet.timeline.length ? proof : el("p", { class: "note" }, "There's no blockchain record to link to yet."));
  const save = el("button", { type: "button", class: "ghost" }, "Download the evidence (for support)");
  save.addEventListener("click", () => download(packet));
  right.append(save, el("p", { class: "hash" }, `Fingerprint ${shortRef(verdict.outputHash)} · case ${shortRef(verdict.incident)} · rules v${verdict.rulesVersion}`));
  out.replaceChildren(head, el("div", { class: "cols" }, left, right));
}

let run = 0;
let timer = null;
let playing = false;
const recorded = new Map();

function setPlaying(on) {
  playing = on;
  clearInterval(timer);
  timer = on ? setInterval(step, CYCLE_MS) : null;
  toggle.textContent = on ? "Pause demo" : "Play demo";
  if (on) hideCaseFile();
}

function busy(on) {
  go.disabled = on;
  go.textContent = on ? "Checking…" : "Check it →";
  toggle.disabled = on;
}

async function loadRecorded(name) {
  if (!recorded.has(name)) {
    const res = await fetch(`fixtures/${name}/case.json`);
    if (!res.ok) throw new Error(name);
    recorded.set(name, await res.json());
  }
  const caseData = recorded.get(name);
  return { caseData, verdict: await buildVerdict(caseData) };
}

const recordedNote = (caseData) => `Saved from public blockchain records on ${dayWords(caseData.evidence.at(-1).observedAt)}. Things may have changed since then: paste the ID to check it live.`;

function present(result, caseId, note, full) {
  const view = caseView(result.verdict);
  const data = stageView(result.caseData, result.verdict);
  const openFile = () => {
    caseFile(result, view, data, note);
    out.hidden = false;
  };
  drawStage(data, view, caseId, openFile);
  if (full) openFile();
}

function hideCaseFile() {
  out.hidden = true;
  out.replaceChildren();
}

/** A notice is advice about a valid ID (a payout, a busy account): same place, plain text, not shown as an error. */
function fail(text, notice = false) {
  stage.classList.remove("reading");
  clearStage("unknown");
  const words = notice ? el("p", { class: "a-who", role: "status" }, text) : el("p", { class: "a-who error", role: "alert" }, text);
  answer.replaceChildren(el("div", { class: "a-words" }, el("p", { class: "a-eyebrow" }, notice ? "Try another ID" : "No answer"), words));
  hideCaseFile();
}

async function openRecorded(name, full) {
  const mine = ++run;
  busy(false);
  try {
    const result = await loadRecorded(name);
    if (mine !== run) return;
    present(result, name, recordedNote(result.caseData), full);
    if (full) out.scrollIntoView({ block: "start" });
  } catch {
    if (mine === run) fail("We couldn't load this example. Refresh the page to try again.");
  }
}

function step() {
  if (document.hidden || !rig.offsetParent) return;
  const now = CASE_BUTTONS.findIndex((b) => b.getAttribute("aria-pressed") === "true");
  openRecorded(CASES[(now + 1) % CASES.length], false);
}

function bringStageIntoView() {
  const top = stage.getBoundingClientRect().top;
  if (top < 0 || top > innerHeight * 0.5) stage.scrollIntoView({ block: "start" });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setPlaying(false);
  const mine = ++run;
  hideCaseFile();
  stage.classList.add("reading");
  clearStage("unknown");
  answer.replaceChildren(el("div", { class: "a-words" }, el("p", { class: "a-eyebrow" }, "Checking"), el("p", { class: "a-who" }, "Checking public blockchain records from your browser…"), el("p", { class: "a-q" }, "This can take up to 90 seconds.")));
  for (const b of CASE_BUTTONS) b.setAttribute("aria-pressed", "false");
  busy(true);
  bringStageIntoView();
  try {
    const r = await withDeadline(openCase($("id").value, { now: new Date().toISOString() }), READ_LIMIT_MS, { error: "The public records took too long to answer, so we can't give an answer. Try again in a minute." });
    if (mine !== run) return;
    busy(false);
    if (r.error) return fail(r.error, r.notice);
    present(r, null, null, true);
  } catch {
    if (mine !== run) return;
    busy(false);
    fail("Something went wrong while checking, so we can't give an answer. Try again, or paste a different ID from the same swap.");
  }
});

for (const b of CASE_BUTTONS) {
  b.addEventListener("click", () => {
    setPlaying(false);
    openRecorded(b.dataset.case, true);
  });
}

for (const b of document.querySelectorAll("#view-explained [data-open]")) {
  b.addEventListener("click", () => {
    setPlaying(false);
    location.hash = "#top";
    showTab();
    openRecorded(b.dataset.open, true);
  });
}

toggle.addEventListener("click", () => setPlaying(!playing));

const guide = new Set([...$("view-explained").querySelectorAll("[id]")].map((n) => n.id));

function showTab() {
  const id = location.hash.slice(1);
  const explained = guide.has(id);
  $("view-check").hidden = explained;
  $("view-explained").hidden = !explained;
  for (const [tab, on] of [["tab-check", !explained], ["tab-explained", explained]]) {
    if (on) $(tab).setAttribute("aria-current", "page");
    else $(tab).removeAttribute("aria-current");
  }
  if (explained) document.getElementById(id).scrollIntoView({ block: "start" });
  else requestAnimationFrame(() => drawBeam(false));
}

// The wheel of blockchains it can follow, NEAR in the middle, and the badge for the latest day pinned on NEAR.
function buildWheel() {
  const [hub, ...rest] = wheelChains();
  const wheel = $("wheel");
  $("wheel-count").textContent = String(rest.length + 1);
  wheel.setAttribute("aria-label", `Blockchains it can follow: ${[hub, ...rest].map((c) => c.name).join(", ")}`);
  wheel.style.setProperty("--cycle", `${rest.length * 0.4}s`);
  const split = Math.ceil(rest.length * 0.6);
  let n = 0;
  for (const [kind, list] of [["outer", rest.slice(0, split)], ["inner", rest.slice(split)]]) {
    const ring = el("div", { class: `w-ring ${kind}` });
    list.forEach((c, i) => {
      const coinNode = el("span", { class: "w-coin", title: c.name }, el("img", { src: `logos/${c.logo}.svg`, alt: "", width: 34, height: 34 }));
      coinNode.style.setProperty("--a", `${(360 / list.length) * i}deg`);
      coinNode.style.setProperty("--d", `${(n++) * 0.4}s`);
      ring.append(coinNode);
    });
    wheel.append(ring);
  }
  wheel.append(el("div", { class: "w-hub" }, el("img", { src: `logos/${hub.logo}.svg`, alt: "", width: 40, height: 40 }), el("b", {}, hub.name), el("small", {}, "where swaps settle")));
  const strip = $("chain-strip");
  for (const c of [hub, ...rest].slice(0, 8)) strip.append(el("img", { src: `logos/${c.logo}.svg`, alt: "", title: c.name }));
  strip.append(el("span", {}, el("b", {}, `${rest.length + 1} blockchains`), ` · +${rest.length - 7} more ↓`));
  const badge = $("pin-badge");
  badge.href = pinUrl(LATEST_PIN);
  badge.append(el("img", { src: "logos/near-protocol.svg", alt: "" }), el("span", {}, "Pinned on NEAR"), el("b", {}, dayWords(LATEST_PIN.day)), el("small", {}, `${LATEST_PIN.cases} cases · ${LATEST_PIN.network} · see the pin →`));
}
buildWheel();

addEventListener("hashchange", showTab);
addEventListener("resize", () => drawBeam(false));
showTab();
openRecorded(CASES[0], false);
setPlaying(!calm.matches);
