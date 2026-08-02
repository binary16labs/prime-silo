#!/usr/bin/env node
// estate — the operator CLI for the governed estate.
//
// WHY THIS EXISTS (the dogfooding failure it fixes):
// The estate preaches contract-bound, gated, signed execution — and then its own
// work was run through ad-hoc shell scripts. Measured on 2026-08-01: of 11 recent
// executions, 9 were UNCONTRACTED, and the signed launch ledger held exactly one
// entry, which was a test of the signing path rather than real work. The governed
// path existed but was not the easy path, so nobody used it.
//
// This CLI is the easy path. It calls THE SAME functions the HTTP control plane
// calls — one allowlist, one gate, one signature, one ledger — so CLI and API
// cannot drift, and an operator never needs an agent to run anything.
//
//   node scripts/estate.mjs status
//   node scripts/estate.mjs contracts
//   node scripts/estate.mjs run longview-map-delta --operator nsdha --yes
//   node scripts/estate.mjs register --rebuild
//   node scripts/estate.mjs ledger --verify
//   node scripts/estate.mjs gates
//
// Every command supports --json for scripting and --workspace to target a
// workspace. Mutating runs require --operator and --yes; the gate is re-checked
// at launch and refuses server-side, exactly as the HTTP path does.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASH = path.join(REPO, "scratch", "longview_run", "dashboard");
const u = (p) => "file:///" + p.replace(/\\/g, "/");

const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
const flag = (k) => argv.includes(k);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i > 0 && argv[i + 1] ? argv[i + 1] : d; };
const WS = opt("--workspace", process.env.LONGVIEW_WORKSPACE || "sessions_v1");
const JSONOUT = flag("--json");

if (!process.env.BENNY_HOME) process.env.BENNY_HOME = "D:/benny-home/benny";

const out = (human, data) => {
  if (JSONOUT) console.log(JSON.stringify(data, null, 1));
  else human();
};
const pad = (s, n) => String(s == null ? "" : s).padEnd(n);
const die = (msg, code = 1) => { console.error(`estate: ${msg}`); process.exit(code); };

// The control plane core — the SAME module the HTTP API uses.
const control = await import(u(path.join(DASH, "control.mjs")));
const estate = await import(u(path.join(DASH, "estate.mjs")));

// ---------------------------------------------------------------------------
async function cmdStatus() {
  const fw = estate.flywheelState(WS);
  const d = fw.debt, r = fw.readiness, e = fw.estate;
  out(() => {
    console.log(`\nEstate status — workspace ${WS}\n`);
    console.log(`  LONGVIEW debt      ${d.debt}  (${d.verdict})`);
    console.log(`    carded ${d.carded} · quarantined ${d.quarantined} · thin ${d.skipped_thin} · debt ${d.debt}`);
    console.log(`    accounted ${d.accounted}/${d.inventory} · coverage ${d.coverage_pct}%`);
    if (d.debt > 0) console.log(`    clears with: estate run longview-map-delta --operator <you> --yes`);
    console.log(`\n  Flywheel           ${r.turning ? "TURNING" : "NOT TURNING"}`);
    for (const p of r.phases) console.log(`    ${pad(p.id, 12)} ${pad(p.state, 10)} ${p.have}/${p.need}`);
    console.log(`\n  Estate`);
    console.log(`    hub        ${e.hub.name} · drives ${e.hub.drives.map((x) => x.drive + (x.present ? "+" : "-")).join("")}`);
    console.log(`    satellite  ${e.satellite.name} · ${e.satellite.lag_verdict} · last pull ${e.satellite.last_pull ? e.satellite.last_pull.age_days + "d" : "never"}`);
    console.log(`    backup     ${e.backup.verdict} · ${e.backup.latest ? e.backup.latest.name : "none"}`);
    if (fw.blockers.length) {
      console.log(`\n  Blockers`);
      for (const b of fw.blockers) console.log(`    - ${b}`);
    }
    console.log();
  }, fw);
}

async function cmdContracts() {
  const rows = Object.entries(control.LAUNCHABLE).map(([id, c]) => {
    const gate = control.gateFor(id, WS);
    return { id, label: c.label, mutating: Boolean(c.mutating), produces: c.produces,
             allowed: gate.allowed, reasons: gate.reasons };
  });
  out(() => {
    console.log(`\nLaunchable contracts — workspace ${WS}\n`);
    for (const r of rows) {
      console.log(`  ${r.allowed ? "OPEN  " : "CLOSED"} ${pad(r.id, 26)} ${r.mutating ? "[mutating]" : "[read-only]"}  ${r.label}`);
      for (const x of r.reasons) console.log(`           x ${x}`);
    }
    console.log(`\n  run:  node scripts/estate.mjs run <id> --operator <you> --yes\n`);
  }, rows);
}

async function cmdRun() {
  const id = argv[1];
  if (!id) die("usage: estate run <contract-id> --operator <name> [--yes]");
  const c = control.LAUNCHABLE[id];
  if (!c) die(`'${id}' is not on the launch allowlist. See: estate contracts`);
  const operator = opt("--operator", process.env.ESTATE_OPERATOR || "");
  if (c.mutating) {
    if (!operator || operator.trim().length < 2)
      die("a mutating run requires --operator <name> (recorded in the signed launch ledger)");
    if (!flag("--yes"))
      die("a mutating run requires explicit --yes (this is the human signature)");
  }
  const gate = control.gateFor(id, WS);
  if (!gate.allowed) {
    console.error(`estate: gate refused '${id}'`);
    for (const r of gate.reasons) console.error(`  x ${r}`);
    process.exit(2);
  }
  const signed = control.signLaunch(WS, {
    operator: operator || "system", contract_id: id, argv: c.argv(WS),
    intent: opt("--intent", c.label),
    gate_snapshot: { allowed: true, checked_at: new Date().toISOString(), evidence: gate.evidence }
  });
  const run = control.launch(id, WS, signed);
  out(() => {
    console.log(`\n  launched  ${id}`);
    console.log(`  pid       ${run.pid}`);
    console.log(`  signature #${signed.seq} ${String(signed.hmac || "").slice(0, 16)} by ${signed.operator}`);
    console.log(`  device    ${signed.device_id}`);
    console.log(`  log       ${run.log}`);
    console.log(`\n  follow:   node scripts/estate.mjs logs ${id}\n`);
  }, { launched: true, run, signature: signed });
}

async function cmdLogs() {
  const id = argv[1];
  const dir = path.join(process.env.BENNY_HOME.replace(/\\/g, "/"), "workspaces", WS, "longview", "lineage");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith("launch-") && f.endsWith(".log"))
      .filter((f) => !id || f.includes(id))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
  } catch { }
  if (!files.length) die("no launch logs found (has anything been launched through the governed path?)");
  const p = path.join(dir, files[0].f);
  const txt = fs.readFileSync(p, "utf8").split("\n");
  console.log(`\n  ${p}  (${txt.length} lines)\n`);
  console.log(txt.slice(-Number(opt("--tail", "25"))).join("\n"));
}

async function cmdRegister() {
  if (flag("--rebuild")) {
    const r = spawnSync("node", [path.join(REPO, "scripts", "longview", "lib", "exec_register.mjs"),
      "--workspace", WS], { cwd: REPO, encoding: "utf8", env: process.env, timeout: 600000 });
    console.log((r.stdout || r.stderr || "").trim());
    return;
  }
  const p = path.join(process.env.BENNY_HOME.replace(/\\/g, "/"), "workspaces", WS,
    "longview", "lineage", "execution_register.json");
  let reg;
  try { reg = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { die("register not built — run: estate register --rebuild"); }
  const t = reg.totals;
  out(() => {
    console.log(`\nExecution Contract Register — workspace ${WS}`);
    console.log(`  generated  ${reg.generated_at}`);
    console.log(`  executions ${t.executions}  (${t.bound_to_contract} contract-bound, ` +
                `${t.executions - t.bound_to_contract} UNCONTRACTED)`);
    console.log(`  processes  ${t.processes} (${t.failed_processes} failed)`);
    console.log(`  datasets   ${t.datasets} · contracts ${reg.sources.contracts}`);
    console.log(`  ledger     ${reg.sources.governance_log.segments} segments, ${reg.sources.governance_log.lines} lines`);
    console.log(`  integrity  ${t.integrity_hashed_events} hashed events, ${t.integrity_hashed_records} hashed records`);
    console.log(`  by type    ${JSON.stringify(t.by_type)}`);
    console.log(`  binding    ${JSON.stringify(t.binding_methods)}\n`);
  }, reg.totals);
}

async function cmdLedger() {
  const v = control.verifyLedger(WS);
  const p = path.join(process.env.BENNY_HOME.replace(/\\/g, "/"), "workspaces", WS,
    "longview", "lineage", "launch_ledger.jsonl");
  let entries = [];
  try {
    entries = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { }
  out(() => {
    console.log(`\nSigned launch ledger — ${v.entries} entries · chain ${v.ok ? "VERIFIED" : "BROKEN"} · key ${v.key_present ? "present" : "MISSING"}`);
    for (const e of entries.slice(-15)) {
      console.log(`  #${pad(e.seq, 4)} ${pad((e.ts || "").replace("T", " ").slice(0, 16), 17)} ` +
                  `${pad(e.operator, 12)} ${pad(e.contract_id, 26)} ${String(e.hmac || "").slice(0, 12)}`);
    }
    if (!v.ok) for (const b of v.broken) console.log(`  BROKEN seq ${b.seq}: ${b.why}`);
    console.log();
  }, { verification: v, entries });
}

async function cmdGates() {
  const gates = [
    ["metric-integrity", ["node", [path.join(REPO, "scripts", "gates", "metric_integrity.mjs"), "--workspace", WS]]],
    ["w0-board", ["node", [path.join(REPO, "scripts", "gates", "w0.mjs")]]]
  ];
  const results = [];
  for (const [name, [bin, args]] of gates) {
    const r = spawnSync(bin, args, { cwd: REPO, encoding: "utf8", env: process.env, timeout: 600000 });
    results.push({ gate: name, exit: r.status, ok: r.status === 0,
                   output: String(r.stdout || "").trim().split("\n").slice(-3).join(" | ") });
  }
  out(() => {
    console.log(`\nGates — workspace ${WS}\n`);
    for (const r of results) console.log(`  [${r.ok ? "PASS" : "FAIL"}] ${pad(r.gate, 18)} exit=${r.exit}`);
    const bad = results.filter((r) => !r.ok);
    if (bad.length) console.log(`\n  ${bad.length} gate(s) failing — see: node scripts/gates/<name>\n`);
    else console.log();
  }, results);
  process.exit(results.some((r) => !r.ok) ? 2 : 0);
}

function cmdHelp() {
  console.log(`
estate — operator CLI for the governed estate (no agent required)

  status                        debt, flywheel readiness, hub/satellite, backup
  contracts                     launchable contracts and their gate state
  run <id> --operator <name> --yes [--intent "..."]
                                gated + signed launch (same path as the HTTP API)
  logs [<id>] [--tail N]        tail the newest governed launch log
  register [--rebuild]          Execution Contract Register summary
  ledger [--verify]             signed launch ledger + chain verification
  gates                         run metric-integrity and w0

Global: --workspace <ws>   --json   (BENNY_HOME honoured; ESTATE_OPERATOR sets a default operator)

Mutating runs require --operator and --yes. That IS the human signature: it is written
into a hash-chained, HMAC-signed ledger bound to this machine's device id, together with
a snapshot of the gate evidence at the moment of launch.

HTTP parity — the API calls these same functions:
  GET  /api/control/state      GET  /api/control/flywheel
  GET  /api/control/register   GET  /api/control/ledger
  POST /api/control/launch     POST /api/control/rebuild
`);
}

const table = { status: cmdStatus, contracts: cmdContracts, run: cmdRun, logs: cmdLogs,
                register: cmdRegister, ledger: cmdLedger, gates: cmdGates,
                help: async () => cmdHelp() };
const fn = table[cmd];
if (!fn) { cmdHelp(); process.exit(1); }
await fn();
