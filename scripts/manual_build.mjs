#!/usr/bin/env node
// Operating manual — one source, three consumptions, none of them hand-maintained.
//
// A manual that is written separately from the code is wrong within a month, and the worst
// kind of wrong: confidently specific about something that no longer exists. So manual.json is
// the only thing anyone edits, and everything else is generated from it:
//
//   OPERATING-MANUAL.md   the human read
//   manual.rag.jsonl      retrievable chunks, so the agent answers from the manual
//   manual.triples.json   graph facts, so the agent can traverse features and arcs
//
// The property that makes it trustworthy is not the generation, it is the CHECK. Every file a
// feature cites, every surface it names, every API it advertises and every command it prints
// is resolved against the repository. A claim that cannot be resolved fails the build.
//
//   THE MANUAL CANNOT DESCRIBE SOMETHING THAT IS NOT THERE.
//
// That is what "deterministic" has to mean for a document. Generating it from a file is only
// reproducibility; refusing to generate it when it has drifted is correctness. Run with
// --check in CI to assert the manual still matches the code without writing anything.
//
// Usage:
//   node scripts/manual_build.mjs [--check] [--out manual/] [--quiet]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const OUT = path.resolve(repo, arg("out", "manual"));
const CHECK = has("check");
const say = (...m) => {
  if (!has("quiet")) console.log(...m);
};

const src = path.join(repo, "manual", "manual.json");
const manual = JSON.parse(fs.readFileSync(src, "utf8"));

// Applications onboarded through app_onboard.mjs become features automatically. If step 5 of
// the workflow meant "now go and hand-write a manual entry", it would be skipped, and the
// agent's memory would know about every feature except the ones most recently added — exactly
// the drift this file exists to prevent.
const appsDir = path.join(repo, "manual", "apps");
if (fs.existsSync(appsDir)) {
  for (const f of fs.readdirSync(appsDir).filter((x) => x.endsWith(".json"))) {
    const app = JSON.parse(fs.readFileSync(path.join(appsDir, f), "utf8"));
    manual.features.push({
      id: `app-${app.id}`,
      name: app.title,
      arc: "files",
      purpose: `An application onboarded into the estate, authorised by proposal:${app.proposal_id}.`,
      how: [
        `Check where it stands: node scripts/app_onboard.mjs status --app ${app.id}`,
        `Place a copy on this machine: node scripts/app_onboard.mjs place --app ${app.id} --at <path>`,
        `Source of record: ${app.source}`
      ],
      invariants: [
        `Nothing was fetched or installed until proposal:${app.proposal_id} carried a human signature.`,
        "Its placements and runs are folded from the ledger, never from a stored status."
      ],
      evidence: ["scripts/app_onboard.mjs"],
      tags: ["application", "onboarded"],
      onboarded: true
    });
  }
}

// --- the check: every claim must resolve ------------------------------------------------
const problems = [];
const exists = (rel) => fs.existsSync(path.join(repo, rel));

const panelSurfaces = new Set();
const panelRoot = path.join(repo, "app", "L0", "_all", "mod");
(function findPanels(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findPanels(full);
    else if (e.name.endsWith(".yaml") && full.includes(`${path.sep}panels${path.sep}`)) {
      const m = fs.readFileSync(full, "utf8").match(/^path:\s*(.+)$/m);
      if (m) panelSurfaces.add(m[1].trim());
    }
  }
})(panelRoot);

const apiRoute = (spec) => {
  // "POST /api/gov_raise" -> server/api/gov_raise.js
  const m = String(spec).match(/\/api\/([a-z0-9_]+)/i);
  return m ? `server/api/${m[1]}.js` : null;
};

function checkRefs(where, obj) {
  for (const rel of obj.evidence ?? [])
    if (!exists(rel)) problems.push(`${where}: evidence file missing — ${rel}`);
  for (const rel of obj.commands ?? [])
    if (!exists(rel)) problems.push(`${where}: command script missing — ${rel}`);
  for (const spec of obj.api ?? []) {
    const f = apiRoute(spec);
    if (!f) problems.push(`${where}: unparseable api spec — ${spec}`);
    else if (!exists(f)) problems.push(`${where}: api handler missing — ${spec} -> ${f}`);
  }
  if (obj.surface && !panelSurfaces.has(obj.surface))
    problems.push(`${where}: no registered panel for surface — ${obj.surface}`);
  // Commands quoted inside prose are checked too: a copy-pasteable line that does not exist
  // is the single most annoying thing a manual can contain.
  for (const line of [...(obj.how ?? []), ...(obj.steps ?? []).map((s) => s.command || "")]) {
    const m = String(line).match(/node (scripts\/[a-z0-9_]+\.mjs)/i);
    if (m && !exists(m[1])) problems.push(`${where}: quoted command does not exist — ${m[1]}`);
  }
}

for (const a of manual.arcs)
  if (!panelSurfaces.has(a.surface))
    problems.push(`arc ${a.id}: no registered panel for surface — ${a.surface}`);
const arcIds = new Set(manual.arcs.map((a) => a.id));
for (const f of manual.features) {
  checkRefs(`feature ${f.id}`, f);
  if (f.arc && !arcIds.has(f.arc)) problems.push(`feature ${f.id}: unknown arc — ${f.arc}`);
}
for (const w of manual.workflows) {
  checkRefs(`workflow ${w.id}`, w);
  for (const s of w.steps)
    if (s.surface && !panelSurfaces.has(s.surface))
      problems.push(`workflow ${w.id} step ${s.n}: no panel for surface — ${s.surface}`);
}

if (problems.length) {
  console.error(`manual has drifted from the code — ${problems.length} unresolved reference(s):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\nFix manual/manual.json (or the code it describes). Nothing was written.`);
  process.exit(1);
}
say(
  `checked: ${manual.features.length} features, ${manual.workflows.length} workflows, ` +
    `${manual.arcs.length} arcs — every reference resolves`
);
if (CHECK) process.exit(0);

// --- generation --------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const arcById = Object.fromEntries(manual.arcs.map((a) => [a.id, a]));
const stableId = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

// 1. the human read
const md = [];
md.push(`# ${manual.title}`, ``, `_${manual.subtitle}_`, ``);
md.push(`## The four rules everything else follows`, ``);
for (const d of manual.doctrine) md.push(`- ${d}`);
md.push(``, `## The arcs`, ``, `| Arc | Job | Surface |`, `| --- | --- | --- |`);
for (const a of manual.arcs) md.push(`| ${a.name} | ${a.role} | \`#/${a.surface}\` |`);
md.push(``, `## Features`, ``);
for (const f of manual.features) {
  md.push(`### ${f.name}`, ``, `**${arcById[f.arc]?.name ?? f.arc} arc** — ${f.purpose}`, ``);
  md.push(`**How**`, ``);
  for (const h of f.how) md.push(`- ${h}`);
  md.push(``, `**What it refuses to do**`, ``);
  for (const i of f.invariants) md.push(`- ${i}`);
  if (f.api?.length) md.push(``, `API: ${f.api.map((x) => `\`${x}\``).join(" · ")}`);
  md.push(``, `Source: ${f.evidence.map((x) => `\`${x}\``).join(", ")}`, ``);
}
md.push(`## Workflows`, ``);
for (const w of manual.workflows) {
  md.push(`### ${w.name}`, ``, w.purpose, ``);
  for (const s of w.steps) {
    md.push(`**${s.n}. ${s.name}** — _${s.actor}_`, ``, s.does, ``);
    if (s.command) md.push("```bash", s.command, "```", ``);
    if (s.gate) md.push(`> ${s.gate}`, ``);
  }
}
const mdPath = path.join(OUT, "OPERATING-MANUAL.md");
fs.writeFileSync(mdPath, md.join("\n") + "\n");

// 2. retrievable chunks. One chunk per feature and per workflow step, each self-contained —
// a chunk that only makes sense beside its neighbour retrieves badly and answers worse.
const chunks = [];
for (const f of manual.features) {
  const text =
    `${f.name} (${arcById[f.arc]?.name ?? f.arc} arc). ${f.purpose} ` +
    `How to use it: ${f.how.join(" ")} ` +
    `What it refuses to do: ${f.invariants.join(" ")}` +
    (f.api?.length ? ` API: ${f.api.join(", ")}.` : "");
  chunks.push({
    id: `manual:feature:${f.id}`,
    hash: stableId(text),
    kind: "feature",
    title: f.name,
    arc: f.arc,
    surface: f.surface ?? arcById[f.arc]?.surface ?? null,
    tags: f.tags ?? [],
    source: f.evidence,
    text
  });
}
for (const w of manual.workflows)
  for (const s of w.steps) {
    const text =
      `${w.name}, step ${s.n} of ${w.steps.length}: ${s.name}. Performed by ${s.actor}. ` +
      `${s.does}${s.command ? ` Command: ${s.command}.` : ""}${s.gate ? ` Gate: ${s.gate}` : ""}`;
    chunks.push({
      id: `manual:workflow:${w.id}:${s.n}`,
      hash: stableId(text),
      kind: "workflow-step",
      title: `${w.name} — ${s.name}`,
      workflow: w.id,
      step: s.n,
      tags: ["workflow", w.id],
      text
    });
  }
fs.writeFileSync(
  path.join(OUT, "manual.rag.jsonl"),
  chunks.map((c) => JSON.stringify(c)).join("\n") + "\n"
);

// The same chunks as a document the ingester will chunk the way we intended. Feeding it the
// headed manual instead produced retrieval hits that were literally the string "**What it
// refuses to do**" — five times, with no content: the splitter cut on structure and handed
// back the labels. So this file has no sub-headings and no lists. Each feature is ONE dense
// paragraph carrying its own context, which is the unit we want returned in the first place.
const ragMd = ["Prime-Silo Operating Manual — retrieval text.", ""];
for (const c of chunks) ragMd.push(`${c.title}. ${c.text}`, "");
fs.writeFileSync(path.join(OUT, "manual.rag.md"), ragMd.join("\n"));

// 3. graph facts. Triples rather than prose, so the agent can traverse "what is on the Gov
// arc", "what enforces this invariant", "what comes after step 2" without re-reading anything.
const triples = [];
const T = (s, p, o) => triples.push({ s, p, o });
for (const a of manual.arcs) {
  T(`arc:${a.id}`, "IS_A", "Arc");
  T(`arc:${a.id}`, "NAMED", a.name);
  T(`arc:${a.id}`, "HAS_ROLE", a.role);
  T(`arc:${a.id}`, "RENDERS_AT", `#/${a.surface}`);
}
for (const f of manual.features) {
  const id = `feature:${f.id}`;
  T(id, "IS_A", "Feature");
  T(id, "NAMED", f.name);
  T(id, "ON_ARC", `arc:${f.arc}`);
  T(id, "PURPOSE", f.purpose);
  for (const i of f.invariants) T(id, "REFUSES", i);
  for (const e of f.evidence) T(id, "IMPLEMENTED_IN", e);
  for (const c of f.commands ?? []) T(id, "RUN_BY", c);
  for (const a of f.api ?? []) T(id, "EXPOSES", a);
  for (const t of f.tags ?? []) T(id, "TAGGED", t);
}
for (const w of manual.workflows) {
  const id = `workflow:${w.id}`;
  T(id, "IS_A", "Workflow");
  T(id, "NAMED", w.name);
  T(id, "PURPOSE", w.purpose);
  for (const s of w.steps) {
    const sid = `${id}:step:${s.n}`;
    T(sid, "IS_A", "WorkflowStep");
    T(sid, "STEP_OF", id);
    T(sid, "POSITION", String(s.n));
    T(sid, "NAMED", s.name);
    T(sid, "PERFORMED_BY", s.actor);
    if (s.command) T(sid, "COMMAND", s.command);
    if (s.gate) T(sid, "GATED_BY", s.gate);
    const next = w.steps.find((x) => x.n === s.n + 1);
    if (next) T(sid, "PRECEDES", `${id}:step:${next.n}`);
  }
}
fs.writeFileSync(
  path.join(OUT, "manual.triples.json"),
  JSON.stringify({ generated_from: "manual/manual.json", triples }, null, 2) + "\n"
);

// 4. the tour page. Generated like everything else — a hand-written HTML copy would drift
// from the manifest within a week, and it is the copy people actually read.
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const slug = (s) =>
  String(s)
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase();

const byArc = new Map(manual.arcs.map((a) => [a.id, []]));
for (const f of manual.features) {
  if (!byArc.has(f.arc)) byArc.set(f.arc, []);
  byArc.get(f.arc).push(f);
}

const html = [];
html.push(`<title>Prime-Silo Operating Manual</title>`);
html.push(`<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">`);
html.push(`<style>
:root{
  --ground:#f7f5ef; --raised:#fffdf8; --ink:#1e211b; --ink-2:#4a4f45; --ink-3:#7b8074;
  --moss:#4a5d45; --sage:#9caf88; --taupe:#c4a882; --rust:#b5563a; --rule:#e0dbcd;
  --refuse:#f2ede0;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#14150f; --raised:#1c1e17; --ink:#ece6d8; --ink-2:#c3bdae; 
  --ink-3:#8d8f82; --moss:#9cb494; --sage:#9caf88; --taupe:#d8bc96; --rust:#e08163;
  --rule:#2e3128; --refuse:#20231a;
}}
:root[data-theme="dark"]{
  --ground:#14150f; --raised:#1c1e17; --ink:#ece6d8; --ink-2:#c3bdae; --ink-3:#8d8f82;
  --moss:#9cb494; --sage:#9caf88; --taupe:#d8bc96; --rust:#e08163;
  --rule:#2e3128; --refuse:#20231a;
}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);
  font-family:"IBM Plex Sans",system-ui,-apple-system,Segoe UI,sans-serif;
  font-size:17px;line-height:1.62;margin:0}
.wrap{display:grid;grid-template-columns:15rem minmax(0,1fr);gap:3rem;
  max-width:74rem;margin:0 auto;padding:3rem 1.5rem 6rem}
nav{position:sticky;top:2rem;align-self:start;font-size:.94rem}
nav h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);
  margin:0 0 .6rem;font-weight:600}
nav a{display:block;padding:.28rem 0;color:var(--ink-2);text-decoration:none;
  border-left:2px solid transparent;padding-left:.7rem}
nav a:hover,nav a:focus-visible{color:var(--rust);border-left-color:var(--rust)}
nav .role{color:var(--ink-3);font-size:.82rem}
main{min-width:0;max-width:68ch}
h1{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:clamp(2.1rem,5vw,3rem);
  line-height:1.12;margin:0 0 .4rem;text-wrap:balance}
.sub{font-size:1.12rem;color:var(--ink-2);margin:0 0 2.5rem;max-width:48ch}
h2{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:1.75rem;line-height:1.2;
  margin:3.5rem 0 .3rem;text-wrap:balance;scroll-margin-top:2rem}
h3{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:1.28rem;line-height:1.25;
  margin:2.4rem 0 .35rem;text-wrap:balance;scroll-margin-top:2rem}
.arc-role{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);
  margin:0 0 1.5rem}
.purpose{color:var(--ink-2);margin:.2rem 0 1rem}
.lab{font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);
  font-weight:600;margin:1.1rem 0 .35rem}
ul{margin:0;padding-left:1.15rem}
li{margin:.3rem 0}
.refuses{background:var(--refuse);border-left:3px solid var(--sage);
  padding:.85rem 1rem .85rem 2rem;border-radius:0 6px 6px 0;margin:.4rem 0 0}
.refuses li{color:var(--ink-2)}
.src{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.8rem;color:var(--ink-3);
  margin-top:.9rem;overflow-x:auto}
code{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.88em;
  background:var(--raised);border:1px solid var(--rule);border-radius:4px;padding:.06em .35em}
pre{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.86rem;line-height:1.55;
  background:var(--raised);border:1px solid var(--rule);border-radius:8px;
  padding:.8rem 1rem;overflow-x:auto;margin:.5rem 0}
pre code{background:none;border:0;padding:0}
.doctrine{list-style:none;padding:0;margin:0 0 1rem;counter-reset:d}
.doctrine li{counter-increment:d;position:relative;padding-left:2.2rem;margin:.7rem 0}
.doctrine li::before{content:counter(d);position:absolute;left:0;top:.1rem;
  font-family:Fraunces,serif;font-size:1.1rem;color:var(--rust);font-weight:600}
.step{border-top:1px solid var(--rule);padding:1.2rem 0 .4rem;display:grid;
  grid-template-columns:2.6rem minmax(0,1fr);gap:0 .8rem}
.step-n{font-family:Fraunces,serif;font-size:1.5rem;color:var(--taupe);line-height:1.1}
.step-name{font-weight:600;margin:0}
.actor{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3)}
.step-body{grid-column:2}
.gate{border-left:3px solid var(--rust);padding:.5rem .9rem;margin:.6rem 0 0;
  background:var(--refuse);border-radius:0 6px 6px 0;font-size:.94rem;color:var(--ink-2)}
table{border-collapse:collapse;width:100%;font-size:.94rem;margin:.6rem 0}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--rule)}
th{font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3)}
.foot{margin-top:4rem;padding-top:1.2rem;border-top:1px solid var(--rule);
  font-size:.86rem;color:var(--ink-3)}
@media (max-width:820px){
  .wrap{grid-template-columns:minmax(0,1fr);gap:1.5rem;padding:2rem 1.15rem 4rem}
  nav{position:static}
  nav a{display:inline-block;padding:.2rem .55rem;border-left:0;border-bottom:2px solid transparent}
  nav .role{display:none}
}
</style>`);

html.push(`<div class="wrap"><nav aria-label="Contents"><h2>Arcs</h2>`);
for (const a of manual.arcs) {
  if (!byArc.get(a.id)?.length) continue;
  html.push(
    `<a href="#arc-${esc(a.id)}">${esc(a.name)} <span class="role">· ${esc(a.role)}</span></a>`
  );
}
html.push(`<h2 style="margin-top:1.4rem">Workflows</h2>`);
for (const w of manual.workflows) html.push(`<a href="#wf-${esc(w.id)}">${esc(w.name)}</a>`);
html.push(`</nav><main>`);

html.push(`<h1>${esc(manual.title)}</h1>`);
html.push(`<p class="sub">${esc(manual.subtitle)}</p>`);

html.push(`<h2 id="doctrine">The four rules everything else follows</h2>`);
html.push(`<ol class="doctrine">`);
for (const d of manual.doctrine) html.push(`<li>${esc(d)}</li>`);
html.push(`</ol>`);

html.push(`<h2 id="map">The map</h2>`);
html.push(`<table><thead><tr><th>Arc</th><th>Job</th><th>Where</th></tr></thead><tbody>`);
for (const a of manual.arcs)
  html.push(
    `<tr><td>${esc(a.name)}</td><td>${esc(a.role)}</td><td><code>#/${esc(a.surface)}</code></td></tr>`
  );
html.push(`</tbody></table>`);

for (const a of manual.arcs) {
  const fs_ = byArc.get(a.id) ?? [];
  if (!fs_.length) continue;
  html.push(`<h2 id="arc-${esc(a.id)}">${esc(a.name)}</h2>`);
  html.push(`<p class="arc-role">${esc(a.role)} · <code>#/${esc(a.surface)}</code></p>`);
  for (const f of fs_) {
    html.push(`<h3 id="f-${esc(slug(f.id))}">${esc(f.name)}</h3>`);
    html.push(`<p class="purpose">${esc(f.purpose)}</p>`);
    html.push(`<p class="lab">How</p><ul>`);
    for (const h of f.how) {
      const isCmd = /^(node|npx|bash|POST|GET) /.test(h);
      html.push(`<li>${isCmd ? `<code>${esc(h)}</code>` : esc(h)}</li>`);
    }
    html.push(`</ul>`);
    html.push(`<p class="lab">What it refuses to do</p><ul class="refuses">`);
    for (const i of f.invariants) html.push(`<li>${esc(i)}</li>`);
    html.push(`</ul>`);
    if (f.evidence?.length)
      html.push(`<p class="src">${f.evidence.map((e) => esc(e)).join("  ·  ")}</p>`);
  }
}

for (const w of manual.workflows) {
  html.push(`<h2 id="wf-${esc(w.id)}">${esc(w.name)}</h2>`);
  html.push(`<p class="purpose">${esc(w.purpose)}</p>`);
  for (const s of w.steps) {
    html.push(`<div class="step"><div class="step-n">${s.n}</div><div>`);
    html.push(`<p class="step-name">${esc(s.name)}</p>`);
    html.push(`<p class="actor">${esc(s.actor)}</p></div>`);
    html.push(`<div class="step-body"><p>${esc(s.does)}</p>`);
    if (s.command) html.push(`<pre><code>${esc(s.command)}</code></pre>`);
    if (s.surface) html.push(`<p><code>#/${esc(s.surface)}</code></p>`);
    if (s.gate) html.push(`<p class="gate">${esc(s.gate)}</p>`);
    html.push(`</div></div>`);
  }
}

html.push(
  `<p class="foot">Generated from <code>manual/manual.json</code> by ` +
    `<code>scripts/manual_build.mjs</code>. Every file, panel, endpoint and command named on ` +
    `this page is resolved against the repository at build time — the build fails rather than ` +
    `describe something that is not there. ${manual.features.length} features · ` +
    `${manual.workflows.length} workflows · ${chunks.length} retrievable chunks · ` +
    `${triples.length} graph facts.</p>`
);
html.push(`</main></div>`);

const htmlPath = path.join(OUT, "tour.html");
fs.writeFileSync(htmlPath, html.join("\n") + "\n");

say(`wrote:`);
say(`  ${path.relative(repo, htmlPath)}  (tour page)`);
say(`  ${path.relative(repo, mdPath)}  (${md.length} lines)`);
say(`  ${path.relative(repo, path.join(OUT, "manual.rag.jsonl"))}  (${chunks.length} chunks)`);
say(`  ${path.relative(repo, path.join(OUT, "manual.triples.json"))}  (${triples.length} triples)`);
