// Memo-Ray child service (MEMORAY-MERGE.md — Phase 1).
//
// memo-ray is the memory graph of the cognitive mesh (third graph beside
// knowledge + code). It used to live in a SEPARATE repo/app the user had to run
// by hand; it is now VENDORED into prime-silo at memoray/server and started as a
// child process here, so the desktop app is a single application. The vendored
// server stays CommonJS and runs as its own localhost process — prime-silo's
// existing proxy (server/lib/memoray_proxy.js) already points at it via the
// apps.lock.json registry, so nothing downstream changes.
//
// Best-effort and additive: if the vendored server is missing (e.g. a stripped
// build) every control no-ops gracefully and the shell still runs — the memory
// page/widgets just render their friendly "Memo-Ray not running" state.
//
// We spawn through Electron's own binary with ELECTRON_RUN_AS_NODE=1 so a
// packaged app needs no system `node` on PATH (same trick the Benny runtime
// supervisor uses). The server resolves its own port from apps.lock.json (key
// mem0ray / memory-graph), falling back to :3030; we don't force PORT.

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

// Locate the vendored memo-ray server entry across dev + packaged layouts.
// Dev:      <repo>/memoray/server/index.js         (packaging/desktop → up 2)
// Packaged: <resources>/memoray/server/index.js    (shipped via extraResources)
function resolveServerEntry(resourcesPath = process.resourcesPath, here = __dirname) {
  const candidates = [
    resourcesPath ? path.join(resourcesPath, "memoray", "server", "index.js") : "",
    path.join(here, "..", "..", "memoray", "server", "index.js")
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* try next */
    }
  }
  return "";
}

function memorayAvailable(resourcesPath, here) {
  return Boolean(resolveServerEntry(resourcesPath, here));
}

let memorayProc = null;

function startMemoray({ resourcesPath, here, env } = {}) {
  if (memorayProc && !memorayProc.killed) return true;
  const entry = resolveServerEntry(resourcesPath, here);
  if (!entry) {
    console.warn("[Memo-Ray] vendored server not found; skipping start.");
    return false;
  }
  try {
    memorayProc = spawn(process.execPath, [entry], {
      cwd: path.dirname(entry),
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore",
      windowsHide: true,
      detached: false
    });
    memorayProc.on("exit", () => {
      memorayProc = null;
    });
    memorayProc.on("error", (e) => {
      console.error("[Memo-Ray] server failed:", e.message);
      memorayProc = null;
    });
    return true;
  } catch (e) {
    console.error("[Memo-Ray] server spawn error:", e.message);
    memorayProc = null;
    return false;
  }
}

function stopMemoray() {
  if (memorayProc && !memorayProc.killed) {
    try {
      memorayProc.kill();
    } catch {
      /* ignore */
    }
  }
  memorayProc = null;
}

function isMemorayRunning() {
  return Boolean(memorayProc && !memorayProc.killed);
}

// Tear down on app quit.
function stopAllMemorayServices() {
  stopMemoray();
}

module.exports = {
  resolveServerEntry,
  memorayAvailable,
  startMemoray,
  stopMemoray,
  isMemorayRunning,
  stopAllMemorayServices
};
