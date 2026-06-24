// Tray-driven Benny service control for the packaged desktop shell.
//
// The desktop shell runs the Node server in-process, but the Benny Python
// runtime (Documents/RAG, graphs, deep-produce, pypes) is a separate process the
// shell proxies to at RUNTIME_BASE_URL (default 127.0.0.1:8005). Historically
// the operator had to start it by hand. This module lets the tray drive it:
// locate a portable Benny install, start/stop its services, probe whether the
// runtime is up, and open a CLI console with the environment already wired so
// `benny …` just works.
//
// It does NOT bundle Python/Benny — it drives an existing install resolved from
// (in order) the configured Benny home, $BENNY_HOME, or PATH. When none is
// found the caller surfaces a "Configure Benny Home…" affordance.

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const DEFAULT_RUNTIME_BASE_URL = "http://127.0.0.1:8005";

function runtimeBaseUrl() {
  return (process.env.RUNTIME_BASE_URL || DEFAULT_RUNTIME_BASE_URL).replace(/\/+$/, "");
}

// Resolve the Benny portable home from explicit config, then the environment.
function resolveBennyHome(configuredHome) {
  const candidates = [configuredHome, process.env.BENNY_HOME];
  for (const candidate of candidates) {
    const dir = String(candidate || "").trim();
    if (dir && fs.existsSync(dir)) {
      return dir;
    }
  }
  return "";
}

// Resolve a runnable Benny launcher. Prefers the portable `bin/` launcher under
// the resolved home (it self-locates $BENNY_HOME), then falls back to PATH.
function resolveBennyLauncher(configuredHome) {
  const home = resolveBennyHome(configuredHome);
  const isWin = process.platform === "win32";
  const launcherName = isWin ? "benny.cmd" : "benny";
  if (home) {
    const binDir = path.join(home, "bin");
    const launcher = path.join(binDir, launcherName);
    if (fs.existsSync(launcher)) {
      return { command: launcher, home, binDir, source: "home" };
    }
  }
  // PATH fallback — the command exists somewhere on PATH.
  return {
    command: launcherName,
    home,
    binDir: home ? path.join(home, "bin") : "",
    source: "path"
  };
}

// Open a native console with BENNY_HOME + bin/ on PATH, optionally running a
// command (e.g. "up", "init"). Windows is wired fully; macOS/Linux open at the
// home dir where the self-locating launchers work via ./bin/benny.
function openBennyConsole({ home, binDir, command = "" } = {}) {
  const cwd = home && fs.existsSync(home) ? home : process.cwd();
  try {
    if (process.platform === "win32") {
      const setEnv = [];
      if (home) setEnv.push(`set "BENNY_HOME=${home}"`);
      if (binDir) setEnv.push(`set "PATH=${binDir};%PATH%"`);
      const tail = command ? `benny ${command}` : "";
      const script = [...setEnv, `cd /d "${cwd}"`, tail].filter(Boolean).join(" & ");
      const child = spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", script], {
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true
      });
      child.on("error", (error) =>
        console.error("[Services] Failed to open Benny console:", error)
      );
      child.unref();
      return true;
    }
    const env = { ...process.env };
    if (home) env.BENNY_HOME = home;
    if (binDir) env.PATH = `${binDir}${path.delimiter}${env.PATH || ""}`;
    if (process.platform === "darwin") {
      // Terminal.app can't take inline env easily; open at home (launchers self-locate).
      const child = spawn("open", ["-a", "Terminal", cwd], {
        detached: true,
        stdio: "ignore",
        env
      });
      child.on("error", (error) =>
        console.error("[Services] Failed to open Benny console:", error)
      );
      child.unref();
      return true;
    }
    const candidates = [
      ["x-terminal-emulator", []],
      ["gnome-terminal", [`--working-directory=${cwd}`]],
      ["konsole", ["--workdir", cwd]],
      ["xterm", []]
    ];
    const tryNext = (i) => {
      if (i >= candidates.length) {
        console.error("[Services] No terminal emulator found.");
        return;
      }
      const [cmd, args] = candidates[i];
      const child = spawn(cmd, args, { cwd, detached: true, stdio: "ignore", env });
      child.on("error", () => tryNext(i + 1));
      child.unref();
    };
    tryNext(0);
    return true;
  } catch (error) {
    console.error("[Services] Failed to open Benny console:", error);
    return false;
  }
}

// Start / stop services by opening a console that runs `benny up` (logs stay
// visible) / `benny down`. Setup runs `benny init` then `benny doctor`.
function startBennyServices(configuredHome) {
  const { home, binDir } = resolveBennyLauncher(configuredHome);
  return openBennyConsole({ home, binDir, command: "up" });
}

function stopBennyServices(configuredHome) {
  const { home, binDir } = resolveBennyLauncher(configuredHome);
  return openBennyConsole({ home, binDir, command: "down" });
}

function setupBennyEnvironment(configuredHome) {
  const { home, binDir } = resolveBennyLauncher(configuredHome);
  // init then doctor in one console so the operator sees the result.
  return openBennyConsole({ home, binDir, command: "init && benny doctor" });
}

function openBennyCli(configuredHome) {
  const { home, binDir } = resolveBennyLauncher(configuredHome);
  return openBennyConsole({ home, binDir });
}

// Open a native console wired to the BUNDLED Python + this install's BENNY_HOME,
// so "Open Benny CLI" / "Set up environment" work on a zero-install machine with
// no external Benny on PATH. Unlike openBennyConsole (external launcher), this
// puts the bundled python dir on PATH and sets PYTHONPATH=site;benny so
// `python -m benny_cli …` resolves against the shipped runtime. `command` is the
// benny_cli subcommand to run (e.g. "init"); empty opens an interactive prompt.
function openBundledBennyConsole({ python, site, benny, bennyHome, command = "" } = {}) {
  if (!python || !fs.existsSync(python)) {
    console.error("[Services] Bundled Python not found; cannot open bundled Benny CLI.");
    return false;
  }
  const pyDir = path.dirname(python);
  const pythonPath = [site, benny].filter(Boolean).join(path.delimiter);
  const cwd = bennyHome && fs.existsSync(bennyHome) ? bennyHome : pyDir;
  try {
    if (process.platform === "win32") {
      const setEnv = [
        bennyHome ? `set "BENNY_HOME=${bennyHome}"` : "",
        pythonPath ? `set "PYTHONPATH=${pythonPath}"` : "",
        `set "PATH=${pyDir};%PATH%"`
      ].filter(Boolean);
      const tail = command
        ? `"${python}" -m benny_cli ${command}`
        : `echo Bundled Benny CLI ready.  Try:  python -m benny_cli --help`;
      const script = [...setEnv, `cd /d "${cwd}"`, tail].join(" & ");
      const child = spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", script], {
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true
      });
      child.on("error", (error) =>
        console.error("[Services] Failed to open bundled Benny console:", error)
      );
      child.unref();
      return true;
    }
    const env = { ...process.env };
    if (bennyHome) env.BENNY_HOME = bennyHome;
    if (pythonPath) env.PYTHONPATH = pythonPath;
    env.PATH = `${pyDir}${path.delimiter}${env.PATH || ""}`;
    if (process.platform === "darwin") {
      const child = spawn("open", ["-a", "Terminal", cwd], {
        detached: true,
        stdio: "ignore",
        env
      });
      child.on("error", (error) =>
        console.error("[Services] Failed to open bundled Benny console:", error)
      );
      child.unref();
      return true;
    }
    const candidates = [
      ["x-terminal-emulator", []],
      ["gnome-terminal", [`--working-directory=${cwd}`]],
      ["konsole", ["--workdir", cwd]],
      ["xterm", []]
    ];
    const tryNext = (i) => {
      if (i >= candidates.length) {
        console.error("[Services] No terminal emulator found.");
        return;
      }
      const [cmd, args] = candidates[i];
      const child = spawn(cmd, args, { cwd, detached: true, stdio: "ignore", env });
      child.on("error", () => tryNext(i + 1));
      child.unref();
    };
    tryNext(0);
    return true;
  } catch (error) {
    console.error("[Services] Failed to open bundled Benny console:", error);
    return false;
  }
}

// Is the Benny runtime answering? Probes RUNTIME_BASE_URL/api/health with a
// short timeout. Returns a boolean and never throws.
async function probeBennyRuntime(timeoutMs = 1500) {
  const url = `${runtimeBaseUrl()}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function isBennyInstalled(configuredHome) {
  const { command, source } = resolveBennyLauncher(configuredHome);
  return source === "home" && fs.existsSync(command);
}

module.exports = {
  DEFAULT_RUNTIME_BASE_URL,
  runtimeBaseUrl,
  resolveBennyHome,
  resolveBennyLauncher,
  openBennyConsole,
  openBundledBennyConsole,
  startBennyServices,
  stopBennyServices,
  setupBennyEnvironment,
  openBennyCli,
  probeBennyRuntime,
  isBennyInstalled
};
