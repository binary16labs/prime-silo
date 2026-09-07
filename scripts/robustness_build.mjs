#!/usr/bin/env node
// Robustness diagrams — ICONIX, with the method's own rules enforced.
//
// Robustness analysis is the step between "what the user does" and "how it is built", and its
// value comes entirely from four constraints most people draw straight past:
//
//   an ACTOR may touch only a BOUNDARY
//   a BOUNDARY may touch only actors and CONTROLS
//   an ENTITY may be touched only by a CONTROL
//   CONTROLS may touch boundaries, entities and each other
//
// Which forbids, concretely: a person reaching past the interface, a screen writing to a
// ledger, two screens wired to each other, two stores talking without logic between them.
// Those are not untidy drawings — each describes a design defect, and the notation exists to
// make them visible. Here they fail the build, so the wrong architecture cannot be drawn.
//
//   CORRECT   every edge obeys the four rules; every boundary resolves to a real surface,
//             endpoint or command; every actor is one the estate recognises.
//   COMPLETE  every flow that models an exercised use case has a diagram, and every boundary
//             its use cases declare appears in it. A surface the process touches and the
//             diagram omits is exactly the omission robustness analysis is for.
//
// Usage: node scripts/robustness_build.mjs [--check] [--out manual/] [--quiet]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const OUT = path.resolve(repo, arg("out", "manual"));
const say = (...m) => {
  if (!has("quiet")) console.log(...m);
};

const load = (rel) => JSON.parse(fs.readFileSync(path.join(repo, rel), "utf8"));
const sitemap = load("manual/sitemap.json");
const uc = load("manual/usecases.json");
const flows = load("manual/flows.json");
const doc = load("manual/robustness.json");

const surfaces = new Map();
for (const z of sitemap.zones) for (const s of z.surfaces) surfaces.set(s.route, s);
const actors = new Set(uc.actors.map((a) => a.id));
const flowById = new Map(flows.flows.map((f) => [f.id, f]));
const ucById = new Map(uc.use_cases.map((c) => [c.id, c]));
const exists = (rel) => fs.existsSync(path.join(repo, rel));
const proxyPrefixes = fs
  .readdirSync(path.join(repo, "server", "lib"))
  .filter((f) => /proxy\.js$/.test(f))
  .flatMap((f) => [
    ...fs
      .readFileSync(path.join(repo, "server", "lib", f), "utf8")
      .matchAll(/PATH_PREFIX\s*=\s*"\/api\/([a-z0-9_-]+)"/gi)
  ])
  .map((m) => m[1]);

// The four rules, as the only pairs that may be connected.
const LEGAL = new Set(["actor|boundary", "boundary|control", "control|control", "control|entity"]);
const pairKey = (a, b) => [a, b].sort().join("|");
const WHY = {
  "actor|control": "an actor reaching past the interface into the logic",
  "actor|entity": "an actor reaching straight into a store",
  "boundary|boundary": "two interfaces wired to each other with no logic between them",
  "boundary|entity": "a screen or route writing directly to a store",
  "entity|entity": "two stores talking with nothing deciding between them"
};

const problems = [];
const modelledFlows = new Set();

for (const d of doc.diagrams) {
  const at = d.id;
  const byId = new Map(d.objects.map((o) => [o.id, o]));
  if (byId.size !== d.objects.length) problems.push(`${at}: duplicate object ids`);
  if (!flowById.has(d.flow)) problems.push(`${at}: names unknown flow ${d.flow}`);
  else modelledFlows.add(d.flow);

  for (const o of d.objects) {
    const where = `${at}/${o.id}`;
    if (!["actor", "boundary", "control", "entity"].includes(o.type))
      problems.push(`${where}: unknown stereotype '${o.type}'`);
    if (o.type === "actor" && !actors.has(o.actor))
      problems.push(`${where}: unknown actor '${o.actor}'`);
    if (o.surface && !surfaces.has(o.surface))
      problems.push(`${where}: surface '${o.surface}' is not on the sitemap`);
    if (o.command && !exists(o.command))
      problems.push(`${where}: command '${o.command}' does not exist`);
    if (
      o.endpoint &&
      !exists(`server/api/${o.endpoint}.js`) &&
      !exists(`server/api/${o.endpoint}.mjs`) &&
      !proxyPrefixes.includes(o.endpoint)
    )
      problems.push(`${where}: endpoint /api/${o.endpoint} does not exist`);
    // A boundary is the thing an actor touches; if it names nothing real it is a drawing.
    if (o.type === "boundary" && !o.surface && !o.endpoint && !o.command)
      problems.push(`${where}: boundary names no surface, endpoint or command`);
  }

  for (const e of d.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a) problems.push(`${at}: edge from '${e.from}', which is not an object`);
    if (!b) problems.push(`${at}: edge to '${e.to}', which is not an object`);
    if (!a || !b) continue;
    const key = pairKey(a.type, b.type);
    if (!LEGAL.has(key))
      problems.push(
        `${at}: ${a.type} '${a.id}' → ${b.type} '${b.id}' breaks ICONIX — ${WHY[key] ?? "not a legal connection"}`
      );
  }

  // Every object must participate. An unconnected object is decoration.
  const touched = new Set(d.edges.flatMap((e) => [e.from, e.to]));
  for (const o of d.objects)
    if (!touched.has(o.id)) problems.push(`${at}/${o.id}: drawn but connected to nothing`);

  // The boundaries the underlying use cases declare must appear here.
  const flow = flowById.get(d.flow);
  const declared = new Set();
  for (const id of flow?.use_cases ?? []) {
    const c = ucById.get(id);
    for (const s of c?.surfaces ?? []) declared.add(`surface:${s}`);
    for (const cmd of c?.commands ?? []) declared.add(`command:${cmd}`);
    for (const ep of c?.endpoints ?? []) declared.add(`endpoint:${ep}`);
  }
  const drawn = new Set(
    d.objects
      .filter((o) => o.type === "boundary")
      .flatMap((o) =>
        [
          o.surface && `surface:${o.surface}`,
          o.command && `command:${o.command}`,
          o.endpoint && `endpoint:${o.endpoint}`
        ].filter(Boolean)
      )
  );
  for (const need of declared)
    if (!drawn.has(need))
      problems.push(
        `${at}: use cases for ${d.flow} touch ${need}, but no boundary in the diagram represents it`
      );
}

// Completeness: an exercised process must have a diagram.
for (const f of flows.flows) {
  const anyExercised = (f.use_cases ?? []).some((id) => ucById.get(id)?.verified === "exercised");
  if (anyExercised && !modelledFlows.has(f.id))
    problems.push(`${f.id} (${f.name}) models exercised work but has no robustness diagram`);
}

if (problems.length) {
  console.error(`robustness diagrams do not hold — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const count = (t) =>
  doc.diagrams.reduce((n, d) => n + d.objects.filter((o) => o.type === t).length, 0);
const edges = doc.diagrams.reduce((n, d) => n + d.edges.length, 0);
say(
  `checked: ${doc.diagrams.length} diagrams, ${count("boundary")} boundaries, ${count("control")} controls, ` +
    `${count("entity")} entities, ${edges} edges — every edge legal under ICONIX, every boundary real`
);
if (has("check")) process.exit(0);

// --- emit ---------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/"/g, "'");
fs.mkdirSync(OUT, { recursive: true });
const md = [];
md.push(`# ${doc.title}`, ``, `_${doc.subtitle}_`, ``, doc.doctrine, ``);
md.push(`## The four rules`, ``);
md.push(`| | may connect to |`, `| --- | --- |`);
md.push(`| **Actor** | boundary only |`);
md.push(`| **Boundary** | actors and controls |`);
md.push(`| **Control** | boundaries, entities, other controls |`);
md.push(`| **Entity** | controls only |`);
md.push(
  ``,
  `Anything else is a design defect the notation exists to reveal, and fails this build.`,
  ``
);
md.push(
  `${doc.diagrams.length} diagrams · ${count("boundary")} boundaries · ${count("control")} controls · ${count("entity")} entities`,
  ``
);

for (const d of doc.diagrams) {
  const flow = flowById.get(d.flow);
  md.push(`## ${d.id} · ${flow.name}`, ``);
  md.push(`Flow ${d.flow} · use cases ${flow.use_cases.join(", ")}`, ``);
  md.push("```mermaid", "flowchart LR");
  for (const o of d.objects) {
    if (o.type === "actor") md.push(`  ${o.id}(("${esc(o.name)}"))`);
    else if (o.type === "boundary") md.push(`  ${o.id}["${esc(o.name)}"]`);
    else if (o.type === "control") md.push(`  ${o.id}(["${esc(o.name)}"])`);
    else md.push(`  ${o.id}[("${esc(o.name)}")]`);
  }
  for (const e of d.edges)
    md.push(e.label ? `  ${e.from} -- "${esc(e.label)}" --> ${e.to}` : `  ${e.from} --> ${e.to}`);
  md.push("```", ``);
  for (const t of ["boundary", "control", "entity"]) {
    const list = d.objects.filter((o) => o.type === t);
    if (!list.length) continue;
    md.push(`**${t[0].toUpperCase() + t.slice(1)}** — ` + list.map((o) => o.name).join(" · "), ``);
  }
}
fs.writeFileSync(path.join(OUT, "ROBUSTNESS.md"), md.join("\n"));
say(`wrote:`);
say(`  manual/ROBUSTNESS.md  (${md.length} lines, ${doc.diagrams.length} mermaid diagrams)`);
