// Desktop system tray for the packaged Prime-Silo shell.
//
// Prime-Silo is a long-running cognitive-mesh shell, so it belongs in the tray
// like its Memo-Ray companion: closing the window hides to tray instead of
// quitting, and the tray menu reopens the window, opens the app in a browser,
// surfaces the registry-resolved Memo-Ray endpoint, and quits for real.
//
// Wired from main.js after the main window exists. Kept dependency-free beyond
// electron itself; the Memo-Ray status line reads apps.lock.json directly with
// a tiny inline walk-up so the tray has no cross-module import.

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { app, Tray, Menu, shell, nativeImage, dialog, ipcMain } = require("electron");
const services = require("./services");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const LOCK_FILENAME = "apps.lock.json";
const LOCK_SCHEMA = "aamp.lock/1";
const CONFIG_FILENAME = "prime-silo-config.json";

let tray = null;
let currentHomeDir = null;
let currentBennyHome = null;
let bennyRuntimeUp = false;
let bennyStatusTimer = null;
// Latest lifecycle phase pushed by the runtime supervisor (first-run download →
// start). "" = unknown; others: downloading | starting | running | degraded |
// unavailable | stopped. Drives the status line so the ~380MB first-run fetch is
// visible instead of looking hung.
let runtimePhase = "";
let menuOptions = null;

function getConfigPath() {
  return path.join(app.getPath("userData"), CONFIG_FILENAME);
}

function readConfig() {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf8")) || {};
    }
  } catch {
    // ignore config read errors
  }
  return {};
}

// Merge a patch into the on-disk config so independent settings (homeDir,
// bennyHome) never clobber each other.
function writeConfigPatch(patch) {
  try {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const next = { ...readConfig(), ...patch };
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
  } catch (error) {
    console.error("[Tray] Failed to write config:", error);
  }
}

function readHomeDirectoryConfig() {
  return readConfig().homeDir || null;
}

function writeHomeDirectoryConfig(homeDir) {
  writeConfigPatch({ homeDir: homeDir || null });
}

function readBennyHomeConfig() {
  return readConfig().bennyHome || null;
}

function writeBennyHomeConfig(bennyHome) {
  writeConfigPatch({ bennyHome: bennyHome || null });
}

// Open a native terminal rooted at the configured home directory. Best-effort
// and cross-platform: each branch detaches the child so quitting the tray app
// never takes the terminal with it. Spawn errors fall through to a fallback so
// a missing preferred emulator (e.g. Windows Terminal) degrades gracefully.
function openTerminalAt(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return;
  }
  try {
    if (process.platform === "win32") {
      // Prefer Windows Terminal; fall back to a cmd window via the shell.
      const wt = spawn("wt.exe", ["-d", dir], { detached: true, stdio: "ignore" });
      wt.on("error", () => {
        const fallback = spawn("cmd.exe", ["/c", "start", "cmd.exe", "/K", `cd /d "${dir}"`], {
          detached: true,
          stdio: "ignore",
          windowsVerbatimArguments: true
        });
        fallback.on("error", (error) => console.error("[Tray] Failed to open terminal:", error));
        fallback.unref();
      });
      wt.unref();
    } else if (process.platform === "darwin") {
      const child = spawn("open", ["-a", "Terminal", dir], { detached: true, stdio: "ignore" });
      child.on("error", (error) => console.error("[Tray] Failed to open terminal:", error));
      child.unref();
    } else {
      // Linux: try common emulators in order; first that launches wins.
      const candidates = [
        ["x-terminal-emulator", []],
        ["gnome-terminal", [`--working-directory=${dir}`]],
        ["konsole", ["--workdir", dir]],
        ["xfce4-terminal", [`--working-directory=${dir}`]],
        ["xterm", []]
      ];
      const tryNext = (index) => {
        if (index >= candidates.length) {
          console.error("[Tray] No terminal emulator found to open.");
          return;
        }
        const [command, args] = candidates[index];
        const child = spawn(command, args, { cwd: dir, detached: true, stdio: "ignore" });
        child.on("error", () => tryNext(index + 1));
        child.unref();
      };
      tryNext(0);
    }
  } catch (error) {
    console.error("[Tray] Failed to open terminal:", error);
  }
}

function resolveTrayIcon() {
  const candidates = process.platform === "win32"
    ? [path.join(__dirname, "../platforms/windows/icon.ico")]
    : [
        path.join(__dirname, "../platforms/linux/icons/32x32.png"),
        path.join(__dirname, "../platforms/linux/icons/icon.png")
      ];
  for (const candidate of candidates) {
    try {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) {
        return image;
      }
    } catch {
      // try next candidate
    }
  }
  return nativeImage.createEmpty();
}

// Best-effort read of the registry lockfile so the tray can show where Memo-Ray
// actually listens. Returns the memo-ray url or null.
function readMemorayUrlFromLock() {
  let dir = PROJECT_ROOT;
  while (true) {
    const candidate = path.join(dir, LOCK_FILENAME);
    if (fs.existsSync(candidate)) {
      try {
        const lock = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (lock && lock.schema === LOCK_SCHEMA && lock.services) {
          const entry = lock.services["memo-ray/memory-graph"];
          return entry && entry.url ? entry.url : null;
        }
      } catch {
        return null;
      }
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// The runtime status line, reflecting the supervisor's lifecycle phase. The
// first-run download and start-up are surfaced so the tray never just says
// "stopped" while the runtime is actually being fetched/started.
function runtimeStatusLabel(bundledManaged) {
  switch (runtimePhase) {
    case "downloading":
      return "Benny runtime: downloading runtime… (first run)";
    case "starting":
      return "Benny runtime: starting…";
    case "unavailable":
      return "Benny runtime: unavailable (retries next launch)";
    default:
      break;
  }
  if (bennyRuntimeUp) {
    return bundledManaged ? "Benny runtime: running (bundled)" : "Benny runtime: running";
  }
  return runtimePhase === "degraded" ? "Benny runtime: degraded" : "Benny runtime: stopped";
}

function buildMenu(options) {
  const { showMainWindow, createWindow, getBrowserUrl, requestQuit, runtime } = options;
  // When a bundled runtime is being supervised in-process, Start/Stop drive it;
  // otherwise they drive an external Benny install (services.js).
  const bundledManaged = Boolean(runtime && runtime.isManaged && runtime.isManaged());
  // The BENNY_HOME the supervisor actually uses (configured override or default).
  const managedBennyHome = bundledManaged && runtime.homeDir ? String(runtime.homeDir() || "") : "";
  const memorayUrl = readMemorayUrlFromLock();
  const template = [
    {
      label: "Open Prime-Silo",
      click: () => {
        showMainWindow();
        createWindow();
      }
    },
    {
      label: "Open in browser",
      click: () => {
        const url = getBrowserUrl();
        if (url) {
          void shell.openExternal(url);
        }
      }
    },
    { type: "separator" },
    {
      label: currentHomeDir
        ? `Home: ${path.basename(currentHomeDir)}`
        : "Home: (not configured)",
      click: () => {
        if (currentHomeDir && fs.existsSync(currentHomeDir)) {
          void shell.openPath(currentHomeDir);
        }
      }
    },
    {
      label: "Open Terminal Here",
      enabled: Boolean(currentHomeDir && fs.existsSync(currentHomeDir)),
      click: () => openTerminalAt(currentHomeDir)
    },
    {
      label: "Configure Home Directory...",
      click: async () => {
        const result = await dialog.showOpenDialog({
          title: "Select Prime-Silo Home Directory",
          defaultPath: currentHomeDir || PROJECT_ROOT,
          properties: ["openDirectory"]
        });
        if (!result.canceled && result.filePaths.length > 0) {
          const selectedPath = result.filePaths[0];
          currentHomeDir = selectedPath;
          writeHomeDirectoryConfig(selectedPath);
          if (tray) {
            tray.setContextMenu(buildMenu(options));
          }
        }
      }
    },
    { type: "separator" },
    // ── Benny services ──────────────────────────────────────────────────
    {
      label: runtimeStatusLabel(bundledManaged),
      enabled: false
    },
    {
      label: "Start Benny services",
      click: () => bundledManaged ? void runtime.start() : services.startBennyServices(currentBennyHome)
    },
    {
      label: "Stop Benny services",
      enabled: bennyRuntimeUp,
      click: () => bundledManaged ? void runtime.stop() : services.stopBennyServices(currentBennyHome)
    },
    {
      // In bundled mode the runtime is already initialised by the supervisor;
      // this re-runs `benny_cli init` against the bundled home using the bundled
      // Python (no external Benny needed). Otherwise drive the external install.
      label: bundledManaged ? "Re-initialise environment" : "Set up environment (init + doctor)",
      click: () => {
        if (!bundledManaged) {
          services.setupBennyEnvironment(currentBennyHome);
          return;
        }
        // `benny_cli init` requires --home and --profile; the bundle is native.
        const ctx = runtime.cliContext();
        services.openBundledBennyConsole({
          ...ctx,
          command: `init --home "${ctx.bennyHome}" --profile native`
        });
      }
    },
    {
      label: "Open Benny CLI",
      click: () => bundledManaged
        ? services.openBundledBennyConsole(runtime.cliContext())
        : services.openBennyCli(currentBennyHome)
    },
    {
      label: "Use bundled runtime",
      type: "checkbox",
      checked: readConfig().useBundledRuntime !== false,
      // Persisted; the supervisor reads it at startup, so this applies on the
      // next launch. Lets power users force the external/remote Benny instead.
      click: (item) => {
        writeConfigPatch({ useBundledRuntime: item.checked });
      }
    },
    // In bundled mode the supervisor owns BENNY_HOME (the configured value if set,
    // else the per-user default). Show the live managed home, and let "Open" reveal
    // it. The chooser below relocates it (persisted; applies on next launch).
    ...(bundledManaged && managedBennyHome ? [{
      label: `Benny Home: ${path.basename(managedBennyHome)} (bundled)`,
      click: () => { if (fs.existsSync(managedBennyHome)) void shell.openPath(managedBennyHome); }
    }] : []),
    {
      label: bundledManaged
        ? "Relocate Benny Home (applies next launch)..."
        : (currentBennyHome ? `Benny Home: ${path.basename(currentBennyHome)}` : "Configure Benny Home..."),
      click: async () => {
        const result = await dialog.showOpenDialog({
          title: "Select Benny Home ($BENNY_HOME)",
          defaultPath: currentBennyHome || managedBennyHome || currentHomeDir || PROJECT_ROOT,
          properties: ["openDirectory"]
        });
        if (!result.canceled && result.filePaths.length > 0) {
          currentBennyHome = result.filePaths[0];
          writeBennyHomeConfig(currentBennyHome);
          if (tray) {
            tray.setContextMenu(buildMenu(options));
          }
        }
      }
    },
    { type: "separator" },
    memorayUrl
      ? { label: `Memo-Ray: ${memorayUrl}`, click: () => void shell.openExternal(memorayUrl) }
      : { label: "Memo-Ray: not resolved", enabled: false },
    { type: "separator" },
    {
      label: "Quit Prime-Silo",
      click: () => requestQuit()
    }
  ];
  return Menu.buildFromTemplate(template);
}

// Probe the Benny runtime and, if its up/down state changed, rebuild the menu so
// the status line and Start/Stop enablement reflect reality.
async function refreshBennyRuntimeStatus(options) {
  const wasUp = bennyRuntimeUp;
  bennyRuntimeUp = await services.probeBennyRuntime();
  if (bennyRuntimeUp !== wasUp && tray) {
    tray.setContextMenu(buildMenu(options));
  }
}

/**
 * Create the tray. Options:
 *   showMainWindow() - restore + focus the existing window
 *   createWindow()   - (re)create the window if it was destroyed
 *   getBrowserUrl()  - current server browser URL (for "Open in browser")
 *   requestQuit()    - mark a real quit then app.quit()
 * Returns the Tray instance (or null if one already exists / creation failed).
 */
function createDesktopTray(options = {}) {
  if (tray) {
    return tray;
  }
  try {
    tray = new Tray(resolveTrayIcon());
  } catch (error) {
    console.error("[Tray] Failed to create tray:", error);
    tray = null;
    return null;
  }

  menuOptions = options;
  currentHomeDir = readHomeDirectoryConfig();
  currentBennyHome = readBennyHomeConfig();

  tray.setToolTip("Prime-Silo");
  const refreshMenu = () => tray && tray.setContextMenu(buildMenu(options));
  refreshMenu();

  // Rebuild on open so the Memo-Ray line and Benny status reflect reality.
  tray.on("click", () => {
    options.showMainWindow();
    options.createWindow();
  });
  tray.on("right-click", () => {
    refreshMenu();
    void refreshBennyRuntimeStatus(options);
  });

  // Poll the Benny runtime so the status line stays live without a click.
  void refreshBennyRuntimeStatus(options);
  bennyStatusTimer = setInterval(() => void refreshBennyRuntimeStatus(options), 15000);

  return tray;
}

// Push a runtime lifecycle phase from the supervisor (main.js wires this as the
// supervisor's onStatus). Safe to call before the tray exists — the phase is
// stored and reflected when the menu is next built. Rebuilds the menu live so
// the status line updates without waiting for the next poll/right-click.
function setRuntimePhase(phase) {
  runtimePhase = String(phase || "");
  if (runtimePhase === "running") {
    bennyRuntimeUp = true;
  } else if (runtimePhase === "unavailable" || runtimePhase === "stopped") {
    bennyRuntimeUp = false;
  }
  if (tray && menuOptions) {
    try {
      tray.setContextMenu(buildMenu(menuOptions));
    } catch {
      // ignore transient menu rebuild errors
    }
  }
}

function destroyDesktopTray() {
  if (bennyStatusTimer) {
    clearInterval(bennyStatusTimer);
    bennyStatusTimer = null;
  }
  if (tray) {
    try {
      tray.destroy();
    } catch {
      // ignore
    }
    tray = null;
  }
}

module.exports = { createDesktopTray, destroyDesktopTray, setRuntimePhase };
