#!/usr/bin/env node
// Workflow registry CLI — "what workflows exist and what is the latest of each?" in one command.
// Canonical: the console UI and /api/workflows read the same registry.mjs.
//
//   node scripts/workflows/cli.mjs           # table of every type + its latest
//   node scripts/workflows/cli.mjs --json    # machine-readable (what the UI consumes)
//   node scripts/workflows/cli.mjs togaf_sad # all versions of one type
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load the project .env exactly as `space serve` does, so the CLI and the server resolve the SAME
// BENNY_HOME/LONGVIEW_WORKSPACE and can never disagree about what the latest artifact is.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
try {
  const { loadProjectEnvFiles } = await import("../../server/lib/utils/env_files.js");
  loadProjectEnvFiles(REPO);
} catch { /* no .env available — fall back to ambient env + defaults */ }

const { discoverWorkflows } = await import("./registry.mjs"); // after env, so defaults resolve

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const only = argv.find((a) => !a.startsWith("--"));

const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const day = (ts) => (ts ? String(ts).slice(0, 10) : "—");

const reg = discoverWorkflows({ repoRoot: REPO }); // module-derived, so the CLI works from any cwd

if (json) {
  console.log(JSON.stringify(reg, null, 2));
  process.exit(0);
}

const scanned = reg.workspaces.filter((w) => w.scanned).map((w) => w.name);
console.log(`\nscanned ${scanned.length} workspace(s): ${scanned.join(", ") || "none"}` +
  (reg.private_excluded ? `   (${reg.private_excluded} private workspace(s) excluded)` : ""));

if (only) {
  const t = reg.types.find((x) => x.id === only || x.label.toLowerCase().includes(only.toLowerCase()));
  if (!t) { console.error(`unknown workflow type: ${only}`); process.exit(2); }
  console.log(`\n■ ${t.label}  (${t.kind}) — ${t.count} version(s)`);
  console.log(`  produces:  ${t.produces}`);
  console.log(`  generator: ${t.generator}\n`);
  for (const v of t.versions) {
    const mark = v === t.latest ? "→" : " ";
    const extra = [v.model && `model=${v.model}`, v.formats?.length && `[${v.formats.join(",")}]`,
                   v.quality != null && `q=${v.quality}`, v.agg_nll != null && `nll=${v.agg_nll}`]
      .filter(Boolean).join("  ");
    console.log(` ${mark} ${short(v.label, 44).padEnd(45)} ${day(v.generated)}  ${extra}`);
  }
  console.log();
  process.exit(0);
}

console.log(`\n${"WORKFLOW".padEnd(24)}${"KIND".padEnd(12)}${"LATEST".padEnd(30)}${"WHEN".padEnd(12)}VERSIONS`);
console.log("─".repeat(94));
for (const t of reg.types) {
  const latest = t.latest ? short(t.latest.label, 28) : "— none found —";
  console.log(
    short(t.label, 23).padEnd(24) + t.kind.padEnd(12) + latest.padEnd(30) +
    day(t.latest?.generated).padEnd(12) + String(t.count)
  );
}
console.log(`\n${reg.types.filter((t) => t.available).length}/${reg.types.length} workflow types have artifacts.`);
console.log(`detail: node scripts/workflows/cli.mjs <type-id>   json: --json\n`);
