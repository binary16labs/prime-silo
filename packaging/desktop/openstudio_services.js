// Open-Studio companion services (Phase 5): drive the two OSS tools that the
// Open-Studio integration folds into the stack, from the desktop tray —
//   • opencode  — local coding agent, run in server mode (`opencode serve`)
//   • open-notebook — open NotebookLM, run via its docker-compose
//
// Best-effort and cross-platform. Nothing here is required for the core shell;
// each control degrades gracefully when the tool (opencode CLI / docker) is not
// installed. The compose path + a per-install encryption key are persisted in
// the desktop config so open-notebook stops shipping a hardcoded secret.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const OPEN_NOTEBOOK_API = "http://localhost:5055";
const OPENCODE_SERVE_PORT = 4096; // opencode serve default-ish; surfaced for "attach"

function which(cmd) {
  // Cheap cross-platform PATH probe without extra deps.
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(full)) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function opencodeAvailable() {
  return Boolean(which("opencode"));
}
function dockerAvailable() {
  return Boolean(which("docker"));
}

// ── opencode serve ──────────────────────────────────────────────────────────
let opencodeProc = null;

function startOpencodeServe() {
  if (!opencodeAvailable()) return false;
  if (opencodeProc && !opencodeProc.killed) return true;
  try {
    opencodeProc = spawn("opencode", ["serve", "--port", String(OPENCODE_SERVE_PORT)], {
      detached: false,
      stdio: "ignore"
    });
    opencodeProc.on("exit", () => {
      opencodeProc = null;
    });
    opencodeProc.on("error", (e) => {
      console.error("[OpenStudio] opencode serve failed:", e.message);
      opencodeProc = null;
    });
    return true;
  } catch (e) {
    console.error("[OpenStudio] opencode serve error:", e.message);
    return false;
  }
}

function stopOpencodeServe() {
  if (opencodeProc && !opencodeProc.killed) {
    try {
      opencodeProc.kill();
    } catch {
      /* ignore */
    }
  }
  opencodeProc = null;
}

function isOpencodeServeRunning() {
  return Boolean(opencodeProc && !opencodeProc.killed);
}

// ── open-notebook (docker compose) ──────────────────────────────────────────
// The compose file lives outside this repo (the operator's machine). We persist
// its path via the desktop config patch passed in. A per-install encryption key
// is generated once and exported into the child env so the compose no longer
// needs the hardcoded `OPEN_NOTEBOOK_ENCRYPTION_KEY=benny`.

function ensureEncryptionKey(readConfig, writeConfigPatch) {
  const cfg = readConfig() || {};
  if (cfg.openNotebookEncryptionKey) return cfg.openNotebookEncryptionKey;
  const key = crypto.randomBytes(24).toString("base64url");
  writeConfigPatch({ openNotebookEncryptionKey: key });
  return key;
}

function composeArgs(composeFile, sub) {
  return composeFile ? ["compose", "-f", composeFile, ...sub] : ["compose", ...sub];
}

function runDocker(args, env) {
  return new Promise((resolve) => {
    try {
      const child = spawn("docker", args, {
        stdio: "ignore",
        detached: true,
        env: { ...process.env, ...env }
      });
      child.on("error", (e) => {
        console.error("[OpenStudio] docker error:", e.message);
        resolve(false);
      });
      child.on("exit", (code) => resolve(code === 0));
      child.unref();
    } catch (e) {
      console.error("[OpenStudio] docker spawn error:", e.message);
      resolve(false);
    }
  });
}

function defaultComposeFile() {
  // Common location the operator used during Open-Studio setup.
  const guess = path.join(os.homedir(), "docker-compose.yml");
  return fs.existsSync(guess) ? guess : "";
}

async function startOpenNotebook({ composeFile, readConfig, writeConfigPatch } = {}) {
  if (!dockerAvailable()) return false;
  const file =
    composeFile || (readConfig && readConfig().openNotebookComposeFile) || defaultComposeFile();
  const key =
    readConfig && writeConfigPatch ? ensureEncryptionKey(readConfig, writeConfigPatch) : undefined;
  const env = key ? { OPEN_NOTEBOOK_ENCRYPTION_KEY: key } : {};
  return runDocker(composeArgs(file, ["up", "-d"]), env);
}

async function stopOpenNotebook({ composeFile, readConfig } = {}) {
  if (!dockerAvailable()) return false;
  const file =
    composeFile || (readConfig && readConfig().openNotebookComposeFile) || defaultComposeFile();
  return runDocker(composeArgs(file, ["down"]), {});
}

async function isOpenNotebookRunning(timeoutMs = 1200) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OPEN_NOTEBOOK_API}/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Tear everything down on app quit.
function stopAllOpenStudioServices(opts = {}) {
  stopOpencodeServe();
  // open-notebook is detached docker; only stop it if the caller asks (it may be
  // shared / long-lived), so default is to leave it running.
  if (opts.stopOpenNotebook) {
    void stopOpenNotebook(opts);
  }
}

module.exports = {
  OPEN_NOTEBOOK_API,
  OPENCODE_SERVE_PORT,
  opencodeAvailable,
  dockerAvailable,
  startOpencodeServe,
  stopOpencodeServe,
  isOpencodeServeRunning,
  startOpenNotebook,
  stopOpenNotebook,
  isOpenNotebookRunning,
  ensureEncryptionKey,
  defaultComposeFile,
  stopAllOpenStudioServices
};
