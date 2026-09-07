#!/usr/bin/env node
// Estate sitemap — derived from the code, checked in both directions.
//
// A sitemap drawn by hand is a picture of what someone believed the system looked like on the
// day they drew it. This one is read out of the repository every time it is built: the panels
// that are registered, the endpoints those panels actually call, and the commands that have no
// panel at all. Nothing here is asserted; every node came from a file.
//
// "Six sigma correct and complete" only means something if both halves are checked, so both
// are, and the build fails on either:
//
//   CORRECT   — every node on the map resolves to something real. A surface must have a view,
//               an endpoint a panel calls must exist on disk.
//   COMPLETE  — everything real appears on the map. A registered panel, an API route or an
//               estate script that the sitemap does not account for is reported by name.
//
// The second is the half people skip, and it is the half that matters: a map that quietly
// omits a surface is worse than no map, because it is trusted. Unreachable routes are reported
// rather than failed — a route with no panel is often a CLI or agent path, which is a fact
// about the estate worth seeing, not an error.
//
// Usage: node scripts/sitemap_build.mjs [--check] [--out manual/] [--quiet]
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

// --- what the estate is FOR. The only hand-written thing in this file, because a job is a
// human judgement about a surface, not a fact derivable from it. Every panel must map to one,
// and an unmapped panel fails the build rather than being silently filed under "other".
const ZONES = {
  Decide: ["_prime_silo/gov"],
  Prove: ["_prime_silo/lineage", "_prime_silo/benny_record", "_prime_silo/manifest_explorer"],
  Watch: ["_prime_silo/mission_control", "_prime_silo/bridge"],
  Recall: [
    "_prime_silo/memory",
    "_prime_silo/lifelog",
    "_prime_silo/session_graph",
    "_prime_silo/setup"
  ],
  Replay: ["time_travel", "_prime_silo/step_through"],
  Ask: ["agent"],
  Hold: ["file_explorer"],
  Think: ["huggingface"],
  Operate: ["user"]
};

const read = (p) => fs.readFileSync(p, "utf8");
const exists = (p) => fs.existsSync(path.join(repo, p));

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// --- 1. surfaces: every registered panel ------------------------------------------------
const panelFiles = walk(path.join(repo, "app", "L0", "_all", "mod")).filter(
  (f) => f.endsWith(".yaml") && f.includes(`${path.sep}panels${path.sep}`)
);

const field = (text, key) => (text.match(new RegExp(`^${key}:\\s*(.+)$`, "m")) || [])[1]?.trim();

const surfaces = panelFiles.map((file) => {
  const text = read(file);
  const dir = path.dirname(path.dirname(path.dirname(file))); // …/<panel>/ext/panels/x.yaml
  // The endpoints a surface calls are read out of its own source. This is the difference
  // between "these are related" and "this page fetches that route".
  const js = walk(dir).filter((f) => /\.(js|mjs|html)$/.test(f));
  const calls = new Set();
  for (const f of js)
    for (const m of read(f).matchAll(/["'`]\/api\/([a-z0-9_]+)/gi)) calls.add(m[1]);
  return {
    name: field(text, "name") || path.basename(dir),
    route: field(text, "path") || "",
    description: field(text, "description") || "",
    icon: field(text, "icon") || "",
    colour: (field(text, "color") || "").replace(/"/g, ""),
    dir: path.relative(repo, dir).replace(/\\/g, "/"),
    hasView: fs.existsSync(path.join(dir, "view.html")),
    endpoints: [...calls].sort()
  };
});

// --- 2. the headless half: commands with no panel ----------------------------------------
const scripts = fs
  .readdirSync(path.join(repo, "scripts"))
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => {
    const text = read(path.join(repo, "scripts", f));
    // Second comment line is the one-liner every estate script carries under its title.
    const lines = text.split("\n").filter((l) => l.startsWith("//"));
    return {
      command: `node scripts/${f}`,
      file: `scripts/${f}`,
      summary: (lines[1] || lines[0] || "").replace(/^\/\/\s?/, "").trim()
    };
  });

// --- 3. the API surface -------------------------------------------------------------------
const apiDir = path.join(repo, "server", "api");
const routes = fs.existsSync(apiDir)
  ? fs
      .readdirSync(apiDir)
      .filter((f) => /\.(js|mjs)$/.test(f))
      .map((f) => f.replace(/\.(js|mjs)$/, ""))
  : [];

// Not every endpoint is a file. Some /api paths are PREFIXES forwarded to another service —
// /api/runtime to Benny, /api/memoray to Memo-Ray — and there is no server/api/runtime.js to
// find. The first run of this check reported the Bridge panel as calling a route that does not
// exist; the panel was right and the check was wrong. The prefixes are read out of the proxy
// modules rather than listed here, so a new proxy does not silently become a false alarm.
const proxyPrefixes = walk(path.join(repo, "server", "lib"))
  .filter((f) => /proxy\.js$/.test(f))
  .flatMap((f) => [...read(f).matchAll(/PATH_PREFIX\s*=\s*"\/api\/([a-z0-9_-]+)"/gi)])
  .map((m) => m[1]);

// --- correctness + completeness -----------------------------------------------------------
const problems = [];
const notes = [];

const zoneOf = {};
for (const [zone, list] of Object.entries(ZONES)) for (const r of list) zoneOf[r] = zone;

for (const s of surfaces) {
  if (!s.route) problems.push(`panel in ${s.dir} declares no path`);
  if (!s.hasView) problems.push(`surface ${s.route} has no view.html in ${s.dir}`);
  if (!zoneOf[s.route])
    problems.push(
      `surface ${s.route} is not assigned to a zone — add it to ZONES in scripts/sitemap_build.mjs ` +
        `(an unplaced surface is exactly what a sitemap exists to reveal)`
    );
  for (const e of s.endpoints)
    if (
      !exists(`server/api/${e}.js`) &&
      !exists(`server/api/${e}.mjs`) &&
      !proxyPrefixes.includes(e)
    )
      problems.push(
        `surface ${s.route} calls /api/${e}, which is neither a route file nor a proxy prefix`
      );
}

for (const r of Object.keys(zoneOf))
  if (!surfaces.some((s) => s.route === r))
    problems.push(`ZONES lists ${r}, but no panel registers that path`);

// Reported, not failed: a route no panel calls is usually a CLI or agent entry point.
const reached = new Set(surfaces.flatMap((s) => s.endpoints));
const unreached = routes.filter((r) => !reached.has(r) && !proxyPrefixes.includes(r)).sort();
if (unreached.length)
  notes.push(
    `${unreached.length} API route(s) are not called by any panel — reachable only from a ` +
      `command line, an agent or an external client: ${unreached.join(", ")}`
  );

if (problems.length) {
  console.error(`sitemap does not match the code — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

say(
  `checked: ${surfaces.length} surfaces, ${routes.length} API routes, ${scripts.length} commands ` +
    `— every surface resolves, is zoned, and every endpoint it calls exists`
);
for (const n of notes) say(`note: ${n}`);
if (has("check")) process.exit(0);

// --- emit ---------------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const byZone = Object.keys(ZONES).map((zone) => ({
  zone,
  surfaces: surfaces
    .filter((s) => zoneOf[s.route] === zone)
    .sort((a, b) => a.name.localeCompare(b.name))
}));

const sitemap = {
  generated_from: "scripts/sitemap_build.mjs",
  counts: {
    surfaces: surfaces.length,
    routes: routes.length,
    commands: scripts.length,
    unreached_routes: unreached.length
  },
  zones: byZone,
  commands: scripts,
  routes_without_a_panel: unreached
};
fs.writeFileSync(path.join(OUT, "sitemap.json"), JSON.stringify(sitemap, null, 2) + "\n");

const md = [];
md.push(`# Estate sitemap`, ``);
md.push(
  `Every surface the estate presents, grouped by the job it does. Generated from the code by`,
  `\`scripts/sitemap_build.mjs\` and checked both ways: each node resolves to a real panel,`,
  `view and endpoint, and every registered panel appears here. The build fails rather than`,
  `show a map that has drifted.`,
  ``
);
md.push(
  `${surfaces.length} surfaces · ${routes.length} API routes · ${scripts.length} commands`,
  ``
);
for (const { zone, surfaces: list } of byZone) {
  if (!list.length) continue;
  md.push(`## ${zone}`, ``);
  for (const s of list) {
    md.push(`### ${s.name} — \`#/${s.route}\``, ``);
    if (s.description) md.push(s.description, ``);
    if (s.endpoints.length)
      md.push(`Calls: ${s.endpoints.map((e) => `\`/api/${e}\``).join(" · ")}`, ``);
    md.push(`Source: \`${s.dir}\``, ``);
  }
}
md.push(`## Operated from a terminal`, ``);
md.push(`Parts of the estate with no panel — run these directly.`, ``);
for (const c of scripts) md.push(`- \`${c.command}\` — ${c.summary}`);
md.push(``);
if (unreached.length) {
  md.push(`## Routes with no panel`, ``);
  md.push(
    `Reachable from a command line, an agent or an external client, but not from any screen.`,
    `Listed because an endpoint nobody can reach from the UI is a fact worth knowing, not a fault.`,
    ``
  );
  for (const r of unreached) md.push(`- \`/api/${r}\``);
  md.push(``);
}
fs.writeFileSync(path.join(OUT, "SITEMAP.md"), md.join("\n"));

say(`wrote:`);
say(`  manual/SITEMAP.md   (${md.length} lines)`);
say(
  `  manual/sitemap.json (${surfaces.length} surfaces in ${byZone.filter((z) => z.surfaces.length).length} zones)`
);
