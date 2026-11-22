#!/usr/bin/env node
// LONGVIEW V8 cycle CLI (EP-Y Y0). The pipeline writes a cycle with `pipeline.mjs --cycle`;
// this CLI builds one from several runs (a cycle that needed re-runs, like C0) and shows cycles.
//
//   node scripts/longview/cycle.mjs outputs                  # write/refresh cycles/OUTPUTS.json
//   node scripts/longview/cycle.mjs manifest --run <record.json> [--run ...] [--edition <dir>]
//        [--cycle C<n>] [--evidence O8=pass:<ref>] [--dry-run]
//   node scripts/longview/cycle.mjs show [C<n>]              # one-line-per-output view
//
// Paths may be absolute or relative to the workspace (LONGVIEW_WORKSPACE under BENNY_HOME).
import fs from "fs";
import path from "path";
import { workspaceDir } from "./lib/config.mjs";
import { buildCycle, listCycles, writeOutputsCatalogue } from "./lib/cycle.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const all = (n) => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1]] : []));
const opt = (n) => all(n)[0] ?? null;
const has = (n) => args.includes(`--${n}`);
const ws = workspaceDir();
const cyclesDir = path.join(ws, "longview", "cycles");
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ws, p));
const MARK = { pass: "✓", warn: "⚠", fail: "✗", not_run: "·", unjudged: "?", pending: "…", not_built: "○", present: "■", self: "◆" };

function show(id) {
  const ns = listCycles(cyclesDir);
  const cid = id || (ns.length ? `C${ns[ns.length - 1]}` : null);
  if (!cid) return console.log("no cycles yet");
  const m = JSON.parse(fs.readFileSync(path.join(cyclesDir, `${cid}.json`), "utf8"));
  if (m.schema !== "longview.cycle/1") return console.log(`${cid}: ${m.schema || "unknown schema"} (pre-V8 seed; no outputs list)`);
  console.log(`${m.cycle} · ${m.workflow} · ${m.created} · edition ${m.edition?.name ?? "none"} · previous ${m.previous?.cycle ?? "none"} · closed ${m.closed}`);
  for (const o of m.outputs) {
    const why = o.phases ? o.phases.filter((p) => p.verdict !== "pass").map((p) => `${p.id}:${p.verdict}`).join(" ") : o.check || o.file || "";
    console.log(`  ${MARK[o.status] ?? "?"} ${o.id.padEnd(3)} ${o.status.padEnd(9)} ${o.name}${why ? `  — ${why}` : ""}`);
  }
}

if (cmd === "outputs") {
  const r = writeOutputsCatalogue(cyclesDir);
  console.log(`${r.wrote ? "wrote" : "unchanged"} ${r.path} sha256 ${r.sha256.slice(0, 12)}`);
} else if (cmd === "manifest") {
  const evidence = {};
  for (const e of all("evidence")) {
    const m = /^(O\d+)=([a-z_]+)(?::(.*))?$/.exec(e);
    if (!m) throw new Error(`--evidence wants O<n>=<status>[:ref], got ${e}`);
    evidence[m[1]] = { status: m[2], ref: m[3] ?? null };
  }
  const ed = opt("edition");
  const { manifest, path: p, wrote } = buildCycle({
    workspace: ws,
    runFiles: all("run").map(abs),
    editionDir: ed ? abs(ed) : null,
    cycle: opt("cycle"),
    evidence,
    write: !has("dry-run")
  });
  if (has("json")) console.log(JSON.stringify(manifest, null, 2));
  console.log(`${wrote ? "wrote" : "dry-run, not written:"} ${p}`);
  console.log(`  summary: ${Object.entries(manifest.summary).map(([k, v]) => `${v} ${k}`).join(", ")} · hashed ${manifest.hashed.length} files · previous ${manifest.previous?.cycle ?? "none"}`);
} else if (cmd === "show") {
  show(args[1]);
} else {
  console.error("usage: cycle.mjs outputs | manifest --run <record> [--run ...] [--edition <dir>] [--cycle Cn] [--evidence O8=pass:ref] [--dry-run] [--json] | show [Cn]");
  process.exit(1);
}
