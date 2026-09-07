#!/usr/bin/env node
// Use cases — checked against the sitemap, in both directions.
//
// A use-case list is where documentation drift is least visible: prose about "the user reviews
// the queue" survives long after the queue moves, is renamed, or stops existing. So every
// surface, command and endpoint a use case names is resolved against the map built by
// scripts/sitemap_build.mjs and against the repository itself.
//
//   CORRECT   — a use case cannot name a surface, command or endpoint that does not exist.
//   COMPLETE  — every surface on the sitemap is exercised by at least one use case. A screen
//               nobody has a reason to open is either a missing use case or a surface that
//               should not be there, and both are worth a build failure.
//
// One thing is reported rather than enforced, because enforcing it would corrupt it: each use
// case declares whether it was EXERCISED against the live estate or merely DECLARED from the
// surface's own registered description. Gating on that number would create pressure to mark
// things exercised, which is exactly how a coverage figure stops meaning anything. It is
// printed, and the honest ratio is allowed to be low.
//
// Usage: node scripts/usecases_build.mjs [--check] [--out manual/] [--quiet]
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

const sitemapPath = path.join(repo, "manual", "sitemap.json");
if (!fs.existsSync(sitemapPath)) {
  console.error("manual/sitemap.json is missing — run: node scripts/sitemap_build.mjs");
  process.exit(2);
}
const sitemap = JSON.parse(fs.readFileSync(sitemapPath, "utf8"));
const uc = JSON.parse(fs.readFileSync(path.join(repo, "manual", "usecases.json"), "utf8"));

const allSurfaces = new Map();
for (const z of sitemap.zones)
  for (const s of z.surfaces) allSurfaces.set(s.route, { ...s, zone: z.zone });

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

const ACTORS = new Set(uc.actors.map((a) => a.id));
const problems = [];
const covered = new Set();

for (const c of uc.use_cases) {
  const where = `${c.id}`;
  if (!ACTORS.has(c.actor)) problems.push(`${where}: unknown actor '${c.actor}'`);
  if (!c.goal) problems.push(`${where}: no goal`);
  if (!["exercised", "declared"].includes(c.verified))
    problems.push(`${where}: verified must be 'exercised' or 'declared', got '${c.verified}'`);

  for (const s of c.surfaces ?? []) {
    if (!allSurfaces.has(s))
      problems.push(`${where}: names surface '${s}', which is not on the sitemap`);
    else covered.add(s);
  }
  for (const cmd of c.commands ?? [])
    if (!exists(cmd)) problems.push(`${where}: names command '${cmd}', which does not exist`);
  for (const e of c.endpoints ?? [])
    if (
      !exists(`server/api/${e}.js`) &&
      !exists(`server/api/${e}.mjs`) &&
      !proxyPrefixes.includes(e)
    )
      problems.push(
        `${where}: names endpoint /api/${e}, which is neither a route file nor a proxy prefix`
      );
}

// The completeness half. A surface with no use case is the interesting failure: it means
// nobody wrote down a reason to open it.
for (const [route, s] of allSurfaces)
  if (!covered.has(route))
    problems.push(
      `surface ${route} (${s.name}) is on the sitemap but no use case exercises it — ` +
        `write one, or ask why the estate presents a screen nobody has a reason to open`
    );

if (problems.length) {
  console.error(`use cases do not match the estate — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const exercised = uc.use_cases.filter((c) => c.verified === "exercised").length;
say(
  `checked: ${uc.use_cases.length} use cases over ${allSurfaces.size} surfaces — ` +
    `every reference resolves and every surface is covered`
);
say(
  `verification: ${exercised} exercised against the live estate, ` +
    `${uc.use_cases.length - exercised} declared from the surface's own description (not run)`
);
const gaps = uc.use_cases.filter((c) => c.gap);
for (const g of gaps) say(`gap: ${g.id} — ${g.gap}`);
if (has("check")) process.exit(0);

// --- emit ---------------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const md = [];
md.push(`# ${uc.title}`, ``, `_${uc.subtitle}_`, ``);
md.push(
  `${uc.use_cases.length} use cases · ${allSurfaces.size} surfaces, all covered · `,
  `${exercised} exercised, ${uc.use_cases.length - exercised} declared`,
  ``
);
md.push(`## Actors`, ``, uc.actor_note, ``);
for (const a of uc.actors) md.push(`- **${a.name}** (\`${a.id}\`) — ${a.note}`);
md.push(``, `## What "exercised" and "declared" mean`, ``, uc.verification_note, ``);

for (const c of uc.use_cases) {
  const actor = uc.actors.find((a) => a.id === c.actor);
  md.push(`## ${c.id} · ${c.name}`, ``);
  md.push(`**Actor** ${actor.name} · **${c.verified}**`, ``);
  md.push(`**Goal** ${c.goal}`, ``);
  if (c.trigger) md.push(`**Trigger** ${c.trigger}`, ``);
  for (const p of c.preconditions ?? []) md.push(`**Precondition** ${p}`, ``);
  if (c.surfaces?.length)
    md.push(
      `**Surfaces** ` +
        c.surfaces.map((s) => `${allSurfaces.get(s).name} (\`#/${s}\`)`).join(" · "),
      ``
    );
  if (c.commands?.length)
    md.push(`**Commands** ` + c.commands.map((x) => `\`${x}\``).join(" · "), ``);
  if (c.endpoints?.length)
    md.push(`**Endpoints** ` + c.endpoints.map((x) => `\`/api/${x}\``).join(" · "), ``);
  md.push(`**Flow**`, ``);
  c.flow.forEach((step, i) => md.push(`${i + 1}. ${step}`));
  md.push(``, `**Outcome** ${c.outcome}`, ``);
  if (c.refuses?.length) {
    md.push(`**What it refuses to do**`, ``);
    for (const r of c.refuses) md.push(`- ${r}`);
    md.push(``);
  }
  if (c.note) md.push(`> ${c.note}`, ``);
  if (c.gap) md.push(`> **Gap** — ${c.gap}`, ``);
}

md.push(`## Coverage`, ``, `| Zone | Surface | Use cases |`, `| --- | --- | --- |`);
for (const [route, s] of allSurfaces) {
  const list = uc.use_cases.filter((c) => (c.surfaces ?? []).includes(route)).map((c) => c.id);
  md.push(`| ${s.zone} | ${s.name} | ${list.join(", ")} |`);
}
md.push(``);
fs.writeFileSync(path.join(OUT, "USE-CASES.md"), md.join("\n"));

fs.writeFileSync(
  path.join(OUT, "usecases.coverage.json"),
  JSON.stringify(
    {
      generated_from: "scripts/usecases_build.mjs",
      use_cases: uc.use_cases.length,
      surfaces: allSurfaces.size,
      exercised,
      declared: uc.use_cases.length - exercised,
      gaps: gaps.map((g) => ({ id: g.id, gap: g.gap })),
      coverage: [...allSurfaces].map(([route, s]) => ({
        route,
        zone: s.zone,
        name: s.name,
        use_cases: uc.use_cases.filter((c) => (c.surfaces ?? []).includes(route)).map((c) => c.id)
      }))
    },
    null,
    2
  ) + "\n"
);

say(`wrote:`);
say(`  manual/USE-CASES.md            (${md.length} lines)`);
say(`  manual/usecases.coverage.json`);
