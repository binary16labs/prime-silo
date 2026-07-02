// LONGVIEW launcher service — the ONE spawn/status/stop path shared by the
// tray menu and the server API (server/api/longview_*.js), so the EXE and the
// browser UI can never race two runners: the runner itself holds a per-
// workspace lock, and this service reads that lock as the source of truth.
//
// The runner is Node code shipped in the app package (scripts/longview/, see
// package.json build.files). Under Electron there may be no system Node, so
// the child is the app binary itself with ELECTRON_RUN_AS_NODE=1 — under a
// plain `node space serve` dev server, process.execPath IS node and the env
// var is ignored. Output goes to <workspace>/longview/runner.log; progress
// lives in status.json / ledger.jsonl written by the runner (ADR-005 §7).

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const { resolveHome } = require("./home_resolver");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const RUNNER = path.join(PROJECT_ROOT, "scripts", "longview", "longview.mjs");
const WORKSPACE = process.env.LONGVIEW_WORKSPACE || "longview";

function stateDir(...parts) {
  return path.join(resolveHome().bennyHome, "workspaces", WORKSPACE, "longview", ...parts);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readLock() {
  const lock = readJson(stateDir("runner.lock"));
  if (!lock || !lock.pid) return null;
  return { ...lock, alive: pidAlive(lock.pid) };
}

const MODES = {
  delta: ["run", "--delta"],
  all: ["run"],
  inventory: ["run", "--phase", "inventory"],
  extract: ["run", "--phase", "extract"],
  map: ["run", "--phase", "map"],
  model: ["run", "--phase", "model"],
  reduce: ["run", "--phase", "reduce"]
};

function startLongview(mode = "delta") {
  const modeArgs = MODES[mode];
  if (!modeArgs) {
    return { started: false, error: `unknown mode '${mode}' (${Object.keys(MODES).join("|")})` };
  }
  if (!fs.existsSync(RUNNER)) {
    return { started: false, error: `runner not found at ${RUNNER}` };
  }
  const lock = readLock();
  if (lock && lock.alive) {
    return { started: false, error: "already running", pid: lock.pid, since: lock.started_at };
  }

  fs.mkdirSync(stateDir(), { recursive: true });
  const logPath = stateDir("runner.log");
  const log = fs.openSync(logPath, "a");
  fs.writeSync(log, `\n==== longview ${mode} launched ${new Date().toISOString()} ====\n`);

  const child = spawn(process.execPath, [RUNNER, ...modeArgs], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  child.unref();
  fs.closeSync(log);
  return { started: true, pid: child.pid, mode, log: logPath };
}

function logTail(lines = 30) {
  try {
    const text = fs.readFileSync(stateDir("runner.log"), "utf8");
    return text.split("\n").filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

// The transparency surface: who's running (lock), how far along (the runner's
// own heartbeat), and what it said last (log tail). Everything is read from
// disk — no in-memory state, so it's correct across CLI/tray/UI launches.
function longviewStatus({ tail = 20 } = {}) {
  const lock = readLock();
  return {
    format: "prime-silo.longview-status/1",
    workspace: WORKSPACE,
    running: Boolean(lock && lock.alive),
    lock: lock || null,
    heartbeat: readJson(stateDir("status.json")),
    log_tail: logTail(tail),
    paths: {
      state: stateDir(),
      log: stateDir("runner.log"),
      deliverables: path.join(resolveHome().bennyHome, "workspaces", WORKSPACE, "data_out")
    }
  };
}

function stopLongview() {
  const lock = readLock();
  if (!lock || !lock.alive) return { stopped: false, error: "not running" };
  try {
    process.kill(lock.pid);
    return { stopped: true, pid: lock.pid, note: "runner is resume-safe; rerun to continue" };
  } catch (error) {
    return { stopped: false, error: String(error && error.message) };
  }
}

module.exports = { startLongview, longviewStatus, stopLongview, MODES };
