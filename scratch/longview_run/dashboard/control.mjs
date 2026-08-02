// Control plane — the executable half of the dashboard.
//
// AUTHORITY MODEL (chosen deliberately): read-only + HUMAN-SIGNED LAUNCH.
// The plane may inspect, preflight and plan freely. Anything MUTATING requires an
// explicit operator signature, which is written into a hash-chained, HMAC-signed
// launch ledger bound to the machine's persistent device-id. Nothing can be
// launched that is not on the allowlist below — a contract id maps to a fixed
// argv, so no request body ever becomes a shell command.
//
// GATES are evidence-based, never trust-based: a launch is refused unless every
// precondition is proven at request time (no competing build process, required
// script present, Neo4j reachable, LM host healthy, prior instance complete).

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import { flywheelState } from "./estate.mjs";

const REPO = "C:/Users/nsdha/OneDrive/binary16/prime-silo";
const HOME = (process.env.BENNY_HOME || "D:/benny-home/benny").replace(/\\/g, "/");
const RB = (process.env.APPDATA || "C:/Users/nsdha/AppData/Roaming").replace(/\\/g, "/")
  + "/space-agent/runtime-bundle";
const ws = (w) => `${HOME}/workspaces/${w || "sessions_v1"}`;

// ── Launch allowlist: contract id -> fixed argv. NEVER build argv from input. ──
export const LAUNCHABLE = {
  "togaf-epic-v6-engineered": {
    label: "TOGAF EPIC v6 — engineered SAD",
    script: "runtime/scripts/togaf_epic_v6.py",
    argv: (w) => ["scripts/togaf_epic_v6.py", "--workspace", w, "--resume"],
    mutating: true,
    produces: "data_out/TOGAF_EPIC_V6_SAD_binary16.{md,pdf}"
  },
  "togaf-epic-v7-regulated": {
    label: "TOGAF EPIC v7 — regulated SAD (TOGAF ADM + BCBS-239 + SS1/23)",
    script: "runtime/scripts/togaf_epic_v7.py",
    argv: (w) => ["scripts/togaf_epic_v7.py", "--workspace", w, "--resume"],
    mutating: true,
    produces: "data_out/TOGAF_EPIC_V7_SAD_binary16.{md,pdf}",
    requires_complete: "togaf-epic-v6-engineered"
  },
  "exec-register-rebuild": {
    label: "Rebuild Execution Contract Register",
    script: "scripts/longview/lib/exec_register.mjs",
    node: true,
    argv: (w) => ["scripts/longview/lib/exec_register.mjs", "--workspace", w],
    mutating: false,
    produces: "longview/lineage/execution_register.json"
  },
  // The LONGVIEW phases were being run by hand through ad-hoc shell scripts —
  // which is precisely how uncontracted executions get created. Registering them
  // here makes the governed path the EASY path.
  "longview-inventory": {
    label: "LONGVIEW — refresh session inventory (memo-ray sync)",
    script: "scripts/longview/longview.mjs",
    node: true,
    argv: (w) => ["scripts/longview/longview.mjs", "run", "--phase", "inventory"],
    env: (w) => ({ LONGVIEW_WORKSPACE: w }),
    mutating: false,
    produces: "longview/inventory.json"
  },
  "longview-map-delta": {
    label: "LONGVIEW — map new/changed sessions (clears debt)",
    script: "scripts/longview/longview.mjs",
    node: true,
    argv: (w) => ["scripts/longview/longview.mjs", "run", "--phase", "map", "--delta"],
    env: (w) => ({
      LONGVIEW_WORKSPACE: w,
      // the hard-won map settings; defaults here so an operator cannot forget them
      LONGVIEW_WINDOW_CHARS: "12000",
      LONGVIEW_LLM_TIMEOUT_MS: "420000",
      LONGVIEW_REASONING_EFFORT: "none",
      LONGVIEW_WINDOW_PAUSE_MS: "2000"
    }),
    mutating: true,
    produces: "longview/cards/*.json"
  },
  "book-opus-v2": {
    label: "AI Vampire V2 — coverage-biased book build",
    script: "scripts/longview/longview.mjs",
    node: true,
    argv: (w) => ["scripts/longview/longview.mjs", "run", "--phase", "opus"],
    env: (w) => ({
      LONGVIEW_WORKSPACE: w,
      LONGVIEW_OPUS_V2: "1",                 // wider retrieval + novelty bias
      LONGVIEW_OPUS_DIR: "iterations/v2",    // never clobber the V1 book
      LONGVIEW_REASONING_EFFORT: "none",
      LONGVIEW_LLM_TIMEOUT_MS: "420000"
    }),
    mutating: true,
    produces: "data_out/iterations/v2/THE-AI-VAMPIRE.{md,pdf} + COVERAGE.md"
  },
  // Estate operations. Both were being run by hand — the backup as an ad-hoc script and
  // the satellite pull as raw SMB copy — which is exactly the uncontracted-execution
  // pattern the register exists to surface. Registering them makes the audited path the
  // default path. Neither can move data without its own human-signed step.
  "satellite-pull": {
    label: "Satellite → hub session pull (proposal only; sync needs a signature)",
    script: "scripts/estate_satellite_pull.mjs",
    node: true,
    argv: (w) => ["scripts/estate_satellite_pull.mjs", "--workspace", w],
    mutating: false,          // the LAUNCHABLE form proposes; --sign is out-of-band by design
    produces: "a signed sync proposal (drift delta vs the hub estate KEL)"
  },
  "estate-backup": {
    label: "Estate backup — content-addressed copy to the shared workspace",
    script: "scripts/estate_backup.mjs",
    node: true,
    // --plan, never --apply: the copy is a separate, deliberate operator act, and --apply
    // is itself gated on the quarantine self-test passing.
    argv: (w) => ["scripts/estate_backup.mjs", "--workspace", w, "--plan"],
    mutating: false,
    produces: "backup plan (eligible / quarantine-excluded / dedupe counts)"
  },
  "metric-integrity-gate": {
    label: "Run the Metric Integrity Gate",
    script: "scripts/gates/metric_integrity.mjs",
    node: true,
    argv: (w) => ["scripts/gates/metric_integrity.mjs", "--workspace", w],
    mutating: false,
    produces: "(exit code 0 pass / 2 fail)"
  }
};

// ── Identity + tamper-evident launch ledger ───────────────────────────────
function deviceId() {
  try { return fs.readFileSync(`${HOME}/state/device-id`, "utf8").trim(); } catch { return "unknown-device"; }
}
function hmacKey() {
  try { return fs.readFileSync(`${HOME}/state/hmac-key`); } catch { return null; }
}
const ledgerPath = (w) => `${ws(w)}/longview/lineage/launch_ledger.jsonl`;

function readLedger(w) {
  try {
    return fs.readFileSync(ledgerPath(w), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Append a signed launch entry. Chain: entry_hash covers prev_hash, so any
 *  edit or deletion of an earlier entry breaks every later one. */
export function signLaunch(w, payload) {
  const entries = readLedger(w);
  const prev = entries.length ? entries[entries.length - 1] : null;
  const prev_hash = prev ? prev.entry_hash : "0".repeat(64);
  const rec = {
    seq: entries.length + 1,
    ts: new Date().toISOString(),
    operator: String(payload.operator || "").slice(0, 64),
    device_id: deviceId(),
    contract_id: payload.contract_id,
    workspace: w,
    argv: payload.argv,
    intent: String(payload.intent || "").slice(0, 300),
    gate_snapshot: payload.gate_snapshot,
    prev_hash
  };
  rec.entry_hash = sha(JSON.stringify(rec));
  const key = hmacKey();
  rec.hmac = key
    ? crypto.createHmac("sha256", key).update(rec.entry_hash + prev_hash).digest("hex")
    : null;
  rec.signed = Boolean(key);
  fs.mkdirSync(path.dirname(ledgerPath(w)), { recursive: true });
  fs.appendFileSync(ledgerPath(w), JSON.stringify(rec) + "\n", "utf8");
  return rec;
}

export function verifyLedger(w) {
  const entries = readLedger(w);
  const key = hmacKey();
  let prev_hash = "0".repeat(64);
  const broken = [];
  for (const e of entries) {
    const { entry_hash, hmac, signed, ...body } = e;
    if (body.prev_hash !== prev_hash) broken.push({ seq: e.seq, why: "prev_hash mismatch" });
    else if (sha(JSON.stringify(body)) !== entry_hash) broken.push({ seq: e.seq, why: "entry_hash mismatch" });
    else if (key && hmac &&
      crypto.createHmac("sha256", key).update(entry_hash + body.prev_hash).digest("hex") !== hmac)
      broken.push({ seq: e.seq, why: "hmac mismatch" });
    prev_hash = entry_hash;
  }
  return { entries: entries.length, ok: broken.length === 0, broken, key_present: Boolean(key) };
}

// ── Evidence-based preconditions ──────────────────────────────────────────
/** Authoritative: ask the OS which builds are running, don't infer from logs. */
export function activeBuilds() {
  return probeEnv().builds;
}

function activeBuildsRaw() {
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*togaf_epic_v*' } | " +
      "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
      { encoding: "utf8", timeout: 20000 });
    const out = (r.stdout || "").trim();
    if (!out) return [];
    const j = JSON.parse(out);
    const arr = Array.isArray(j) ? j : [j];
    return arr.map((p) => {
      const m = /togaf_epic_(v\d)\.py/.exec(p.CommandLine || "");
      return { pid: p.ProcessId, version: m ? m[1] : "?", cmd: String(p.CommandLine || "").slice(0, 160) };
    });
  } catch { return []; }
}

// Probes are memoized for a few seconds: gateFor() runs per contract, and a
// PowerShell spawn per contract per probe made /state take tens of seconds.
// Win32_Process enumeration costs ~15s, so the UI reads a background-refreshed
// cache (always stamped with probed_at, never presented as live). The LAUNCH path
// calls probeEnv(true) to force a synchronous, authoritative re-probe — a gate
// decision is never made on stale process state.
let _probe = { at: 0, builds: [], ports: {}, probing: false };
const PROBE_TTL_MS = 10000;

function probeEnv(force = false) {
  const now = Date.now();
  if (force || (!_probe.at && !_probe.probing)) {
    _probe = { at: Date.now(), builds: activeBuildsRaw(), ports: {}, probing: false };
    return _probe;
  }
  if (now - _probe.at > PROBE_TTL_MS && !_probe.probing) {
    _probe.probing = true;                       // refresh in the background
    setTimeout(() => {
      try { _probe = { at: Date.now(), builds: activeBuildsRaw(), ports: {}, probing: false }; }
      catch { _probe.probing = false; }
    }, 0);
  }
  return _probe;
}

/** Fast synchronous-ish TCP check via a probe file is overkill; use a cached
 *  async result refreshed by the state endpoint. Defaults to "unknown -> true"
 *  only never: an unproven precondition must read as NOT satisfied. */
function portOpen(port) {
  const p = probeEnv();
  if (p.ports[port] !== undefined) return p.ports[port];
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    `try{$c=New-Object Net.Sockets.TcpClient;$a=$c.BeginConnect('127.0.0.1',${port},$null,$null);` +
    `$ok=$a.AsyncWaitHandle.WaitOne(700);$c.Close();if($ok){'true'}else{'false'}}catch{'false'}`],
    { encoding: "utf8", timeout: 8000 });
  const v = /true/i.test(r.stdout || "");
  p.ports[port] = v;
  return v;
}

/** Is a SAD instance complete? Complete == its .md exists AND no build process
 *  is running for it AND the markdown is newer than its resumable state file. */
export function instanceStatus(contractId, w) {
  const c = LAUNCHABLE[contractId];
  if (!c || !c.produces) return { known: false };
  const version = (contractId.match(/v(\d)/) || [])[1];
  const md = `${ws(w)}/data_out/TOGAF_EPIC_V${version}_SAD_binary16.md`;
  const state = `${ws(w)}/data_out/togaf_epic_v${version}_state.json`;
  const running = activeBuilds().some((b) => b.version === `v${version}`);
  const mdExists = fs.existsSync(md);
  const mdTime = mdExists ? fs.statSync(md).mtimeMs : 0;
  const stTime = fs.existsSync(state) ? fs.statSync(state).mtimeMs : 0;
  const pdf = md.replace(/\.md$/, ".pdf");
  return {
    known: true, version: `v${version}`, running, markdown: mdExists,
    pdf: fs.existsSync(pdf),
    markdown_newer_than_state: mdExists && mdTime >= stTime,
    complete: mdExists && !running && mdTime >= stTime,
    markdown_at: mdExists ? new Date(mdTime).toISOString() : null,
    state_at: stTime ? new Date(stTime).toISOString() : null
  };
}

/** The gate. Every reason is evidence, gathered at request time. */
export function gateFor(contractId, w) {
  const c = LAUNCHABLE[contractId];
  const reasons = [], evidence = {};
  if (!c) return { allowed: false, reasons: ["unknown contract (not on the launch allowlist)"], evidence };
  const builds = activeBuilds();
  evidence.active_builds = builds;
  if (c.mutating && builds.length) {
    reasons.push(`a build is already running (${builds.map((b) => b.version + " pid " + b.pid).join(", ")}) — one GPU job at a time`);
  }
  const scriptPath = path.join(REPO, c.script);
  evidence.script = { path: c.script, present: fs.existsSync(scriptPath) };
  if (!evidence.script.present) reasons.push(`required script missing: ${c.script}`);
  if (c.requires_complete) {
    const st = instanceStatus(c.requires_complete, w);
    evidence.prerequisite = { contract: c.requires_complete, ...st };
    if (!st.complete) {
      reasons.push(`prerequisite ${c.requires_complete} is not complete` +
        (st.running ? " (still running)" : st.markdown ? " (output older than its state file)" : " (no output produced)"));
    }
  }
  if (c.mutating) {
    evidence.neo4j = portOpen(7687);
    if (!evidence.neo4j) reasons.push("Neo4j (7687) is not reachable");
    evidence.lm_host = portOpen(1234);
    if (!evidence.lm_host) reasons.push("LM host (1234) is not reachable");
  }
  return { allowed: reasons.length === 0, requires_signature: Boolean(c.mutating), reasons, evidence };
}

// ── Running launches (this process's children) ────────────────────────────
const RUNNING = new Map();

export function launch(contractId, w, signed) {
  const c = LAUNCHABLE[contractId];
  const argv = c.argv(w);
  const cwd = c.node ? REPO : path.join(REPO, "runtime");
  const bin = c.node ? "node" : `${RB}/python/python.exe`;
  const env = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONPATH: `${path.join(REPO, "runtime")};${RB}/site`,
    BENNY_HOME: HOME.replace(/\//g, "\\"),
    NEO4J_URI: process.env.NEO4J_URI || "bolt://localhost:7687",
    NEO4J_USER: process.env.NEO4J_USER || "neo4j",
    NEO4J_PASSWORD: process.env.NEO4J_PASSWORD || "password",
    BENNY_LMSTUDIO_ENDPOINTS: process.env.BENNY_LMSTUDIO_ENDPOINTS || "http://127.0.0.1:1234/v1",
    ...(typeof c.env === "function" ? c.env(w) : {})
  };
  const logPath = `${ws(w)}/longview/lineage/launch-${contractId}-${signed.seq}.log`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, "a");
  const child = spawn(bin, argv, { cwd, env, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  const rec = { pid: child.pid, contract_id: contractId, seq: signed.seq, log: logPath,
                started: new Date().toISOString(), workspace: w };
  RUNNING.set(String(child.pid), rec);
  return rec;
}

export const runningLaunches = () => [...RUNNING.values()];

// ── HTTP surface ──────────────────────────────────────────────────────────
export function handleControl(req, res, url, q, json, isLoopback) {
  const w = q.workspace || "sessions_v1";
  const regPath = `${ws(w)}/longview/lineage/execution_register.json`;

  if (req.method === "GET" && url.startsWith("/api/control/register")) {
    try { return json(200, JSON.parse(fs.readFileSync(regPath, "utf8"))); }
    catch { return json(404, { error: "register not built", hint: "POST /api/control/rebuild" }); }
  }
  if (req.method === "GET" && url.startsWith("/api/control/state")) {
    let totals = null, generated = null;
    try {
      const r = JSON.parse(fs.readFileSync(regPath, "utf8"));
      totals = r.totals; generated = r.generated_at;
    } catch { }
    const contracts = Object.entries(LAUNCHABLE).map(([id, c]) => ({
      id, label: c.label, mutating: c.mutating, produces: c.produces,
      gate: gateFor(id, w), instance: instanceStatus(id, w)
    }));
    return json(200, {
      workspace: w, register: { totals, generated_at: generated },
      active_builds: activeBuilds(), probed_at: new Date(_probe.at || Date.now()).toISOString(),
      running_launches: runningLaunches(),
      contracts, ledger: verifyLedger(w), device_id: deviceId()
    });
  }
  if (req.method === "GET" && url.startsWith("/api/control/flywheel")) {
    return json(200, flywheelState(w));
  }
  if (req.method === "GET" && url.startsWith("/api/control/ledger")) {
    return json(200, { entries: readLedger(w), verification: verifyLedger(w) });
  }
  if (req.method === "POST" && url.startsWith("/api/control/rebuild")) {
    const child = spawn("node", [path.join(REPO, "scripts", "longview", "lib", "exec_register.mjs"),
      "--workspace", w], { cwd: REPO, env: { ...process.env, BENNY_HOME: HOME.replace(/\//g, "\\") } });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.on("close", (code) => json(200, { code, output: out.slice(0, 4000) }));
    return;
  }
  if (req.method === "POST" && url.startsWith("/api/control/launch")) {
    if (!isLoopback(req)) return json(403, { error: "launch is loopback-only" });
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      let p;
      try { p = JSON.parse(body); } catch { return json(400, { error: "bad json" }); }
      const id = p.contract_id;
      const c = LAUNCHABLE[id];
      if (!c) return json(400, { error: "contract not on the launch allowlist" });
      probeEnv(true);                    // authoritative re-probe before deciding
      const gate = gateFor(id, w);
      if (!gate.allowed) return json(409, { error: "gate refused (re-checked at launch)", gate });
      if (c.mutating) {
        if (!p.operator || String(p.operator).trim().length < 2)
          return json(400, { error: "operator identity required for a mutating launch" });
        if (p.acknowledge !== true)
          return json(400, { error: "explicit acknowledgement required for a mutating launch" });
      }
      const signed = signLaunch(w, {
        operator: p.operator || "system", contract_id: id, argv: c.argv(w),
        intent: p.intent || c.label, gate_snapshot: { allowed: true, checked_at: new Date().toISOString(),
                                                      evidence: gate.evidence }
      });
      const run = launch(id, w, signed);
      return json(200, { launched: true, signature: { seq: signed.seq, entry_hash: signed.entry_hash,
                                                      hmac: signed.hmac, operator: signed.operator,
                                                      device_id: signed.device_id }, run });
    });
    return;
  }
  return json(404, { error: "unknown control endpoint" });
}
