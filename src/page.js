// The page: a recorded case comes from fixtures/, a pasted id is read live from public chains in this browser.
import { openCase } from "./case.js";
import { buildPacket } from "./packet.js";
import { caseView, explorerUrl } from "./render-case.js";
import { shortRef } from "./words.js";
import { buildVerdict } from "./verdict.js";

const $ = (id) => document.getElementById(id);
const out = $("out");

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

function show({ caseData, verdict }, note) {
  const view = caseView(verdict);
  const packet = buildPacket(caseData, verdict);
  const head = el("section", { class: `verdict ${view.tone}` }, el("p", { class: "eyebrow" }, "Who acts next"), el("h2", {}, view.headline));
  if (view.question) head.append(el("p", { class: "question" }, view.question));
  if (note) head.append(el("p", { class: "note" }, note));

  const legs = el("ol", { class: "legs" });
  for (const leg of view.legs) {
    legs.append(el("li", { class: leg.failed ? "failed" : "" }, el("span", { class: "who" }, leg.provider), el("span", { class: "what" }, leg.label), el("span", { class: `cls c-${leg.class.toLowerCase()}` }, leg.classLabel)));
  }

  const notes = el("ul", { class: "notes" });
  for (const w of view.warnings) notes.append(el("li", { class: "warn" }, w));
  for (const c of view.claims) notes.append(el("li", {}, c, " ", el("span", { class: "cls c-reported" }, "Reported")));
  for (const b of view.balances) notes.append(el("li", {}, b));

  const proof = el("ul", { class: "proof" });
  for (const t of packet.timeline) {
    const url = explorerUrl(t.source, t.ref);
    const ref = url ? el("a", { href: url, target: "_blank", rel: "noreferrer" }, shortRef(t.ref)) : el("span", {}, shortRef(t.ref));
    proof.append(el("li", {}, el("time", {}, t.at.slice(0, 16).replace("T", " ")), el("span", { class: "who" }, t.source), ref));
  }

  const save = el("button", { type: "button", class: "ghost" }, "Download evidence packet");
  save.addEventListener("click", () => download(packet));
  const foot = el("p", { class: "hash" }, `Verdict hash ${shortRef(verdict.outputHash)} · rules ${verdict.rulesVersion}`);
  out.replaceChildren(head, el("h3", {}, "What each step proves"), legs);
  if (notes.children.length) out.append(notes);
  if (packet.timeline.length) out.append(el("h3", {}, "Proof"), proof);
  out.append(save, foot);
  out.scrollIntoView({ behavior: "smooth", block: "start" });
}

const say = (text, cls = "reading") => out.replaceChildren(el("p", { class: cls }, text));

async function replay(name) {
  say("Loading the recorded case…");
  const res = await fetch(`fixtures/${name}/case.json`);
  if (!res.ok) return say("That recorded case could not be loaded.", "error");
  const caseData = await res.json();
  show({ caseData, verdict: await buildVerdict(caseData) }, `Recorded from public chain data on ${caseData.evidence.at(-1).observedAt.slice(0, 10)}.`);
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  say("Reading the chains from your browser…");
  try {
    const r = await openCase($("id").value, { now: new Date().toISOString() });
    if (r.error) return say(r.error, "error");
    show(r);
  } catch {
    say("Something went wrong reading that case, so there's no answer. Please try again.", "error");
  }
});

for (const b of document.querySelectorAll("[data-case]")) b.addEventListener("click", () => replay(b.dataset.case));
