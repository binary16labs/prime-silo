#!/usr/bin/env node
// Process flows — a graph, checked as a graph.
//
// Prose flows drift quietly because nothing about them can be wrong in a way a machine
// notices. A flow expressed as steps and transitions can: an edge pointing at a step that was
// renamed, a branch nobody can reach, a step with no way out. All three are build failures
// here, and all three are what actually rots in a diagram nobody re-derives.
//
//   CORRECT   every transition names a step that exists in the same flow; every non-terminal
//             step has a way out; every terminal step has none; every actor, surface, command
//             and endpoint resolves against the sitemap and the repository.
//   COMPLETE  every step is reachable from the start, and every use case marked `exercised`
//             is modelled by a flow. A use case that was actually run and never diagrammed is
//             the gap this document exists to close.
//
// Declared use cases are deliberately NOT required to have flows. Modelling the branches of
// something never run would be inventing them, and an invented flow is worse than an absent
// one because it looks the same as a real one.
//
// Usage: node scripts/flows_build.mjs [--check] [--out manual/] [--quiet]
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
for (const need of ["manual/sitemap.json", "manual/usecases.json", "manual/flows.json"])
  if (!fs.existsSync(path.join(repo, need))) {
    console.error(`${need} is missing — run the sitemap and use-case builds first.`);
    process.exit(2);
  }

const sitemap = load("manual/sitemap.json");
const uc = load("manual/usecases.json");
const doc = load("manual/flows.json");

const surfaces = new Map();
for (const z of sitemap.zones) for (const s of z.surfaces) surfaces.set(s.route, s);
const actors = new Set(uc.actors.map((a) => a.id));
const useCaseIds = new Set(uc.use_cases.map((c) => c.id));
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

const problems = [];
const modelled = new Set();

for (const flow of doc.flows) {
  const at = flow.id;
  const byId = new Map(flow.steps.map((s) => [s.id, s]));
  if (byId.size !== flow.steps.length) problems.push(`${at}: duplicate step ids`);
  if (!byId.has(flow.start)) problems.push(`${at}: start '${flow.start}' is not a step`);

  for (const u of flow.use_cases ?? []) {
    if (!useCaseIds.has(u)) problems.push(`${at}: names unknown use case ${u}`);
    else modelled.add(u);
  }

  for (const s of flow.steps) {
    const where = `${at}/${s.id}`;
    const outs = [...(s.next ? [s.next] : []), ...(s.decision ?? []).map((d) => d.go)];

    if (s.terminal && outs.length) problems.push(`${where}: terminal step also has transitions`);
    if (!s.terminal && !outs.length) problems.push(`${where}: no way out and not terminal`);
    if (!s.terminal && !s.actor) problems.push(`${where}: no actor`);
    if (s.actor && !actors.has(s.actor)) problems.push(`${where}: unknown actor '${s.actor}'`);

    // Dangling edges are the classic diagram rot: a step gets renamed and the arrow keeps
    // pointing at the old name, which reads fine to a human and is meaningless.
    for (const target of outs)
      if (!byId.has(target))
        problems.push(`${where}: transition to '${target}', which is not a step`);

    if (s.surface && !surfaces.has(s.surface))
      problems.push(`${where}: surface '${s.surface}' is not on the sitemap`);
    if (s.command && !exists(s.command))
      problems.push(`${where}: command '${s.command}' does not exist`);
    if (
      s.endpoint &&
      !exists(`server/api/${s.endpoint}.js`) &&
      !exists(`server/api/${s.endpoint}.mjs`) &&
      !proxyPrefixes.includes(s.endpoint)
    )
      problems.push(`${where}: endpoint /api/${s.endpoint} does not exist`);
  }

  // Reachability. An unreachable step is a branch someone wrote and then orphaned — it reads
  // as part of the process and can never happen.
  const seen = new Set();
  const queue = [flow.start].filter((x) => byId.has(x));
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const s = byId.get(id);
    for (const t of [...(s.next ? [s.next] : []), ...(s.decision ?? []).map((d) => d.go)])
      if (byId.has(t)) queue.push(t);
  }
  for (const s of flow.steps)
    if (!seen.has(s.id)) problems.push(`${at}/${s.id}: unreachable from '${flow.start}'`);
  if (!flow.steps.some((s) => s.terminal && seen.has(s.id)))
    problems.push(`${at}: no terminal step is reachable — the process never ends`);
}

// Completeness against what was actually run.
for (const c of uc.use_cases)
  if (c.verified === "exercised" && !modelled.has(c.id))
    problems.push(
      `${c.id} (${c.name}) was exercised against the live estate but no flow models it — ` +
        `a process that was run and never diagrammed is exactly the gap this document closes`
    );

if (problems.length) {
  console.error(`process flows do not match the estate — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const steps = doc.flows.reduce((n, f) => n + f.steps.length, 0);
const terminals = doc.flows.reduce((n, f) => n + f.steps.filter((s) => s.terminal).length, 0);
const refusals = doc.flows.reduce(
  (n, f) =>
    n +
    f.steps.filter(
      (s) =>
        s.terminal && /refus|reject|halt|blocked|drift|partial|vacuous|not-measurable/i.test(s.id)
    ).length,
  0
);
say(
  `checked: ${doc.flows.length} flows, ${steps} steps, ${terminals} terminals — ` +
    `every edge resolves, every step is reachable, every flow ends`
);
say(
  `${refusals} of ${terminals} terminals are refusals or halts — the branches that make this ` +
    `estate what it is`
);
const declared = uc.use_cases.filter((c) => c.verified === "declared").length;
say(
  `${modelled.size} use cases modelled; ${declared} declared use cases deliberately left unmodelled`
);
if (has("check")) process.exit(0);

// --- emit ---------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/"/g, "'").replace(/\n/g, " ");
const clip = (s, n = 64) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

fs.mkdirSync(OUT, { recursive: true });
const md = [];
md.push(`# ${doc.title}`, ``, `_${doc.subtitle}_`, ``, doc.doctrine, ``);
md.push(
  `${doc.flows.length} flows · ${steps} steps · ${terminals} terminals, of which ${refusals} are refusals or halts`,
  ``
);

for (const flow of doc.flows) {
  md.push(`## ${flow.id} · ${flow.name}`, ``);
  md.push(`Use cases: ${flow.use_cases.join(", ")}`, ``);

  md.push("```mermaid", "flowchart TD");
  for (const s of flow.steps) {
    const label = clip(esc(s.terminal || s.action));
    md.push(s.terminal ? `  ${s.id}(["${label}"])` : `  ${s.id}["${esc(s.actor)}: ${label}"]`);
  }
  for (const s of flow.steps) {
    if (s.next) md.push(`  ${s.id} --> ${s.next}`);
    for (const d of s.decision ?? [])
      md.push(`  ${s.id} -- "${clip(esc(d.when), 42)}" --> ${d.go}`);
  }
  md.push("```", ``);

  md.push(`| Step | Actor | What happens | Then |`, `| --- | --- | --- | --- |`);
  for (const s of flow.steps) {
    const then = s.terminal
      ? "_ends here_"
      : s.next
        ? s.next
        : (s.decision ?? []).map((d) => `${d.when} → ${d.go}`).join("; ");
    md.push(
      `| \`${s.id}\` | ${s.actor ?? "—"} | ${s.terminal ? "**" + s.terminal + "**" : s.action} | ${then} |`
    );
  }
  md.push(``);
}
fs.writeFileSync(path.join(OUT, "PROCESS-FLOWS.md"), md.join("\n"));

say(`wrote:`);
say(`  manual/PROCESS-FLOWS.md  (${md.length} lines, ${doc.flows.length} mermaid diagrams)`);
