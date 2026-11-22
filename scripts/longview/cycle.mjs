#!/usr/bin/env node
// LONGVIEW V8 cycle CLI (EP-Y Y0). The pipeline writes a cycle with `pipeline.mjs --cycle`;
// this CLI builds one from several runs (a cycle that needed re-runs, like C0) and shows cycles.
//
//   node scripts/longview/cycle.mjs outputs                  # write/refresh cycles/OUTPUTS.json
//   node scripts/longview/cycle.mjs manifest --run <record.json> [--run ...] [--edition <dir>]
//        [--cycle C<n>] [--evidence O8=pass:<ref>] [--dry-run]
//   node scripts/longview/cycle.mjs show [C<n>]              # one-line-per-output view
// Carry-forward ledger (Y3, cycles/CARRY.jsonl, append-only):
//   node scripts/longview/cycle.mjs carry check C<n>         # nothing-lost check (exit 1 if anything unaccounted)
//   node scripts/longview/cycle.mjs carry add --cycle C<n> --item "<text>" --owner <who> [--source <s>]
//   node scripts/longview/cycle.mjs carry set <id> done --ref <commit|edition|ticket>
//   node scripts/longview/cycle.mjs carry set <id> carried --cycle C<n+1> --note "<why>"
//   node scripts/longview/cycle.mjs carry set <id> dropped --signed-quote "<owner's words>"   (owner only)
//   node scripts/longview/cycle.mjs carry forward C<n> --note "<why>"   # carry every unaccounted C<n> item into C<n+1>
//   node scripts/longview/cycle.mjs close C<n> [--by <who>]  # writes C<n>.closed.json only if the check passes
//
// Paths may be absolute or relative to the workspace (LONGVIEW_WORKSPACE under BENNY_HOME).
import fs from "fs";
import path from "path";
import { workspaceDir } from "./lib/config.mjs";
import { buildCycle, listCycles, writeOutputsCatalogue } from "./lib/cycle.mjs";
import { appendCarry, closeCheck, closeCycle, foldCarry, readCarry } from "./lib/carry.mjs";

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

function printCheck(c) {
  const t = c.tally;
  console.log(
    `${c.ok ? "✓" : "✗"} ${c.cycle} nothing-lost: ${c.unaccounted.length} unaccounted · ${t.done} done · ${t.dropped} dropped · ${t.carried_forward} carried forward · ${t.later} later · ${c.problems.length} ledger problems`
  );
  if (c.unaccounted.length) console.log(`  unaccounted: ${c.unaccounted.join(" ")}`);
  for (const p of c.problems) console.log(`  line ${p.line}${p.id ? ` (${p.id})` : ""}: ${p.problem}`);
}

function carry(sub) {
  const file = path.join(cyclesDir, "CARRY.jsonl");
  if (sub === "check") {
    const c = closeCheck(readCarry(file), args[2]);
    printCheck(c);
    if (!c.ok) process.exitCode = 1;
  } else if (sub === "add") {
    const cyc = opt("cycle");
    const { items } = foldCarry(readCarry(file));
    const k = Math.max(0, ...[...items.keys()].filter((id) => id.startsWith(`${cyc}-`)).map((id) => Number(id.split("-")[1]))) + 1;
    const e = appendCarry(file, { cycle: cyc, id: `${cyc}-${String(k).padStart(2, "0")}`, state: "open", item: opt("item"), owner: opt("owner"), source: opt("source") || "cli" });
    console.log(`opened ${e.id}`);
  } else if (sub === "set") {
    const [id, state] = [args[2], args[3]];
    const { items } = foldCarry(readCarry(file));
    const prev = items.get(id);
    const e = appendCarry(file, {
      id,
      state,
      cycle: opt("cycle") || prev?.cycle,
      ...(opt("ref") ? { ref: opt("ref") } : {}),
      ...(opt("note") ? { note: opt("note") } : {}),
      ...(state === "dropped" ? { signed_by: "owner", signed_quote: opt("signed-quote") } : {})
    });
    console.log(`${e.id} → ${e.state} (${e.cycle})`);
  } else if (sub === "forward") {
    const from = args[2];
    const note = opt("note");
    if (!note) throw new Error("carry forward needs --note (why these items move on)");
    const to = `C${Number(from.slice(1)) + 1}`;
    const c = closeCheck(readCarry(file), from);
    if (c.problems.length) {
      printCheck(c);
      throw new Error("fix the ledger problems first — a bad line could hide an item");
    }
    for (const id of c.unaccounted) appendCarry(file, { id, state: "carried", cycle: to, note });
    console.log(`carried ${c.unaccounted.length} item(s) from ${from} into ${to}`);
  } else throw new Error("carry wants: check | add | set | forward");
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
} else if (cmd === "carry") {
  carry(args[1]);
} else if (cmd === "close") {
  const r = closeCycle({ workspace: ws, cycle: args[1], by: opt("by") });
  printCheck(r.check);
  if (r.closed) console.log(`closed ${args[1]} → ${r.path}`);
  else {
    console.error(`${args[1]} NOT closed: nothing-lost check failed`);
    process.exitCode = 1;
  }
} else {
  console.error("usage: cycle.mjs carry check|add|set|forward … | close Cn | outputs | manifest --run <record> [--run ...] [--edition <dir>] [--cycle Cn] [--evidence O8=pass:ref] [--dry-run] [--json] | show [Cn]");
  process.exit(1);
}
