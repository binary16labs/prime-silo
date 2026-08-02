// Metric Integrity Gate — the adversarial check, institutionalised.
//
// Five governance surfaces were quietly WRONG in a single session, and none of the
// systems caught themselves. All five had the same shape: a derived number that
// flattered the estate. This gate asks, mechanically, the question that found them:
//
//     "what would this look like if it were lying?"
//
// The failure modes it encodes (each one was real, not hypothetical):
//   MI-1 RECONCILIATION   — an accounting that does not add up to its own total.
//                           (debt conflated skipped_thin with backlog: 23 vs 4)
//   MI-2 FALSIFIABILITY   — a readiness metric that cannot fail, because its target
//                           was tuned to the current value. (`need = inventory - 33`)
//   MI-3 CONSISTENCY      — two surfaces deriving the same fact and disagreeing.
//                           (`turning: true` while debt was outstanding)
//   MI-4 SOURCE COVERAGE  — a reader that silently sees only part of its source.
//                           (ledger rotated at 5MB; register lost 191 -> 57 executions)
//   MI-5 PATH INTEGRITY   — a hardcoded home defeating a control while BENNY_HOME is
//                           set. (leak gate scanned 0 files; plan.mjs served 118%)
//   MI-6 LIVENESS         — a surface presented as current that is actually frozen.
//                           (collector dead; dashboard.json 50 min stale)
//
// Deterministic and read-only. Exit 0 = all pass, 2 = at least one FAIL.
// A check that cannot gather its own evidence reports INCONCLUSIVE, never PASS —
// an unprovable control is not a passing control.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const WS = arg("--workspace", process.env.LONGVIEW_WORKSPACE || "sessions_v1");
const HOME = (process.env.BENNY_HOME || "D:/benny-home/benny").replace(/\\/g, "/");
const wsDir = `${HOME}/workspaces/${WS}`;
const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const ageMin = (ms) => Math.round((Date.now() - ms) / 60000);

const results = [];
// Resolved once, up front, so every check below stays synchronous (see `check`).
let MI3_STATE = null;
try {
  const m = await import("file:///" + path.join(REPO, "scratch", "longview_run", "dashboard", "estate.mjs")
    .replace(/\\/g, "/"));
  MI3_STATE = m.flywheelState(WS);
} catch { /* reported as INCONCLUSIVE by MI-3 */ }

// Resolved up front for the same reason as MI3_STATE: every check() must stay synchronous.
// null = endpoint unreachable (inconclusive); a number = chunks it served for THIS workspace.
const MI8_BASE = process.env.BENNY_API_BASE || "http://127.0.0.1:8005";
let MI8_STATE = null;
try {
  const res = await fetch(`${MI8_BASE}/api/rag/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Benny-API-Key": process.env.BENNY_API_KEY || "" },
    body: JSON.stringify({ workspace: WS, query: "architecture decision", top_k: 3 }),
    signal: AbortSignal.timeout(15000)
  });
  if (res.ok) {
    const d = await res.json();
    MI8_STATE = (Array.isArray(d) ? d : d.results || d.documents || []).length;
  }
} catch { /* stays null → INCONCLUSIVE, never a silent pass */ }

const VALID = new Set(["PASS", "FAIL", "INCONCLUSIVE"]);
const check = (id, title, fn) => {
  try {
    const r = fn();
    // Fail closed. An async check returns a Promise whose status is undefined; the
    // first version of this gate counted that as a PASS — the exact failure mode
    // this gate exists to catch, inside the gate itself.
    if (r && typeof r.then === "function") {
      results.push({ id, title, status: "FAIL",
                     detail: "check returned a Promise — asynchronous checks are not supported and must not be scored" });
      return;
    }
    if (!r || !VALID.has(r.status)) {
      results.push({ id, title, status: "FAIL",
                     detail: `check produced no valid status (${r && r.status}) — an unresolved check is not a pass` });
      return;
    }
    results.push({ id, title, ...r });
  } catch (e) {
    results.push({ id, title, status: "INCONCLUSIVE", detail: String(e && e.message).slice(0, 200) });
  }
};

// ── MI-1 reconciliation ───────────────────────────────────────────────────
check("MI-1", "Debt accounting reconciles to inventory", () => {
  const L = `${wsDir}/longview`;
  const inv = readJSON(`${L}/inventory.json`, []);
  if (!Array.isArray(inv) || !inv.length) return { status: "INCONCLUSIVE", detail: "inventory unreadable" };
  const quarantined = new Set((readJSON(`${L}/quarantine.json`, { sids: [] }).sids) || []);
  const cards = new Set(fs.readdirSync(`${L}/cards`)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json")).map((f) => f.replace(/\.json$/, "")));
  const verdicts = new Map();
  for (const line of fs.readFileSync(`${L}/ledger.jsonl`, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const id = e.session_id || e.sid || e.id;
    if (id && (e.status || e.verdict)) verdicts.set(id, e.status || e.verdict);
  }
  let carded = 0, quar = 0, thin = 0, debt = 0;
  for (const e of inv) {
    const sid = e.id || e.session_id || e.sid;
    if (!sid) continue;
    if (quarantined.has(sid)) quar++;
    else if (cards.has(sid)) carded++;
    else if (verdicts.get(sid) === "skipped_thin") thin++;
    else debt++;
  }
  const sum = carded + quar + thin + debt;
  return {
    status: sum === inv.length ? "PASS" : "FAIL",
    detail: `${carded} carded + ${quar} quarantined + ${thin} thin + ${debt} debt = ${sum}; inventory = ${inv.length}`,
    data: { carded, quarantined: quar, thin, debt, inventory: inv.length }
  };
});

// ── MI-2 falsifiability ───────────────────────────────────────────────────
check("MI-2", "Readiness targets are derived, not tuned to pass", () => {
  const src = fs.readFileSync(path.join(REPO, "scratch", "longview_run", "dashboard", "estate.mjs"), "utf8");
  // A literal offset in a readiness target is the signature of a tuned metric.
  const tuned = /need:\s*Math\.max\(\s*\d+\s*,\s*\w+\s*-\s*\d+\s*\)/.test(src);
  const derived = /const eligible = Math\.max\(1, d\.carded \+ d\.debt\)/.test(src);
  return {
    status: !tuned && derived ? "PASS" : "FAIL",
    detail: tuned
      ? "a readiness target uses a hardcoded numeric offset — it cannot fail"
      : derived ? "map target derived from carded + debt (satisfied iff debt == 0)"
                : "could not confirm the map target is derived from the debt accounting"
  };
});

// ── MI-3 cross-surface consistency ────────────────────────────────────────
check("MI-3", "Readiness and debt cannot disagree", () => {
  // Evaluate the LIVE module, not a snapshot — the invariant must hold in the code
  // that actually serves the dashboard, not in a file someone may have refreshed.
  const fw = MI3_STATE;
  if (!fw || !fw.debt || !fw.readiness) {
    return { status: "INCONCLUSIVE", detail: "flywheelState() unavailable from estate.mjs" };
  }
  const map = (fw.readiness.phases || []).find((p) => p.id === "map") || {};
  const zero = fw.debt.debt === 0;
  const consistent = zero === (map.state === "satisfied") && zero === Boolean(fw.readiness.turning);
  return {
    status: consistent ? "PASS" : "FAIL",
    detail: `debt=${fw.debt.debt} · map=${map.state} (${map.have}/${map.need}) · turning=${fw.readiness.turning}` +
            (consistent ? "" : " — surfaces disagree about the same fact")
  };
});

// ── MI-4 source coverage (rotation blindness) ─────────────────────────────
check("MI-4", "Readers cover every segment of their source", () => {
  const dir = path.join(REPO, "runtime", "workspace");
  const onDisk = fs.readdirSync(dir)
    .filter((f) => f === "governance.log" || /^governance\.log\.\d+$/.test(f)).length;
  const reg = readJSON(`${wsDir}/longview/lineage/execution_register.json`);
  if (!reg) return { status: "INCONCLUSIVE", detail: "execution register not built" };
  const read = ((reg.sources || {}).governance_log || {}).segments;
  if (read == null) return { status: "FAIL", detail: "register does not report how many ledger segments it read — rotation loss would be invisible" };
  return {
    status: read >= onDisk ? "PASS" : "FAIL",
    detail: `register read ${read} of ${onDisk} ledger segments on disk` +
            (read < onDisk ? " — rotated history is being silently dropped" : "")
  };
});

// ── MI-5 path integrity ───────────────────────────────────────────────────
check("MI-5", "No control hardcodes a home path while BENNY_HOME is set", () => {
  const suspects = [
    "scratch/longview_run/dashboard/plan.mjs",
    "scratch/longview_run/dashboard/collect.mjs",
    "scripts/longview/lib/leak_gate.mjs",
    "scripts/longview/lib/exec_register.mjs",
    "scratch/longview_run/dashboard/estate.mjs"
  ];
  const bad = [];
  for (const rel of suspects) {
    const p = path.join(REPO, rel);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    // a literal benny-home path that is NOT guarded by a BENNY_HOME fallback
    const hasLiteral = /["'`][A-Za-z]:\/[^"'`]*benny-home/.test(src);
    const honoursEnv = /process\.env\.BENNY_HOME/.test(src);
    if (hasLiteral && !honoursEnv) bad.push(rel);
  }
  return {
    status: bad.length === 0 ? "PASS" : "FAIL",
    detail: bad.length ? `hardcoded home, ignores BENNY_HOME: ${bad.join(", ")}` :
      `${suspects.length} control paths checked; all honour BENNY_HOME or use no literal`
  };
});

// ── MI-6 liveness of surfaces presented as current ────────────────────────
check("MI-6", "Live surfaces are actually live", () => {
  const dash = path.join(REPO, "scratch", "longview_run", "dashboard", "dashboard.json");
  if (!fs.existsSync(dash)) return { status: "INCONCLUSIVE", detail: "dashboard.json absent" };
  const age = ageMin(fs.statSync(dash).mtimeMs);
  const j = readJSON(dash, {});
  const rs = j.run_status || {};
  const declaresState = typeof rs.pipeline_state === "string";
  const stale = age > 5;
  return {
    status: stale ? "FAIL" : declaresState ? "PASS" : "FAIL",
    detail: `dashboard.json is ${age} min old` +
      (stale ? " — presented as live but frozen (is the collector running?)" : "") +
      (declaresState ? `; pipeline_state="${rs.pipeline_state}"` : "; no pipeline_state field — completion is indistinguishable from stalling")
  };
});

// ── MI-7 gates that scan nothing are false passes ─────────────────────────
check("MI-7", "Gates prove they inspected something", () => {
  const reg = readJSON(`${wsDir}/longview/lineage/execution_register.json`);
  if (!reg) return { status: "INCONCLUSIVE", detail: "register absent" };
  const t = reg.totals || {};
  if (!t.executions) return { status: "FAIL", detail: "register reports 0 executions — a control over an empty set is not a passing control" };
  return { status: "PASS", detail: `register covers ${t.executions} executions / ${t.processes} processes; ` +
           `${t.bound_to_contract} contract-bound` };
});

// ── MI-8 the retrieval substrate must actually serve THIS workspace ───────
// Added after the gate passed 7/7 while the book builder wrote 5 sections with ZERO
// retrieved evidence. The benny API on :8005 was running from the runtime bundle, homed at
// %APPDATA%/space-agent/benny-home, which holds no sessions_v1 — so every /api/rag/query
// returned 200 with `{"results":[],"message":"Knowledge base is empty"}` while a 16 MB
// chroma store sat at D:/benny-home/benny/workspaces/sessions_v1/chromadb.
//
// Nothing failed. ragQuery treats an empty result as "no context" by design, and the opus
// prompt falls back to "write only from the chapter brief" — so the run looked healthy,
// logged cites (concept citations, not sids), and would have spent ~8 hours producing an
// ungrounded book. MI-5 checks that CONTROLS honour BENNY_HOME; it never asked whether the
// SERVER did. Same failure class, one layer down.
check("MI-8", "The retrieval server serves the workspace its corpus lives in", () => {
  const onDisk = fs.existsSync(`${wsDir}/chromadb`);
  if (MI8_STATE == null)
    return { status: "INCONCLUSIVE", detail: `retrieval endpoint ${MI8_BASE} unreachable — cannot confirm groundedness` };
  if (!onDisk && MI8_STATE === 0)
    return { status: "INCONCLUSIVE", detail: `no chroma store for ${WS} on disk and none served — nothing to reconcile` };
  if (onDisk && MI8_STATE === 0)
    return { status: "FAIL", detail:
      `a chroma store EXISTS at ${wsDir}/chromadb but ${MI8_BASE} returns 0 results for '${WS}' — ` +
      `the server is homed elsewhere. Anything generated now is ungrounded and will still look successful.` };
  return { status: "PASS", detail: `${MI8_BASE} returned ${MI8_STATE} chunk(s) for '${WS}'; retrieval is grounded` };
});

// ── report ────────────────────────────────────────────────────────────────
const fail = results.filter((r) => r.status === "FAIL");
const inconc = results.filter((r) => r.status === "INCONCLUSIVE");
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ workspace: WS, results, failed: fail.length, inconclusive: inconc.length }, null, 1));
} else {
  console.log(`Metric Integrity Gate — workspace ${WS}\n`);
  for (const r of results) {
    const mark = r.status === "PASS" ? "PASS " : r.status === "FAIL" ? "FAIL " : "INCON";
    console.log(`  [${mark}] ${r.id}  ${r.title}`);
    console.log(`          ${r.detail}`);
  }
  console.log(`\n  ${results.length - fail.length - inconc.length} pass · ${fail.length} fail · ${inconc.length} inconclusive`);
  if (fail.length) console.log("\n  A failing metric-integrity check means a governance number may be flattering the estate.");
}
process.exit(fail.length ? 2 : 0);
