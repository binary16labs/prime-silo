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

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const LOCK_FILENAME = "apps.lock.json";
const LOCK_SCHEMA = "aamp.lock/1";
const CONFIG_FILENAME = "prime-silo-config.json";

let tray = null;
let currentHomeDir = null;

function getConfigPath() {
  return path.join(app.getPath("userData"), CONFIG_FILENAME);
}

function readHomeDirectoryConfig() {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return config.homeDir || null;
    }
  } catch {
    // ignore config read errors
  }
  return null;
}

function writeHomeDirectoryConfig(homeDir) {
  try {
    const configPath = getConfigPath();
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    const config = { homeDir: homeDir || null };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  } catch (error) {
    console.error("[Tray] Failed to write home directory config:", error);
  }
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

function buildMenu({ showMainWindow, createWindow, getBrowserUrl, requestQuit }) {
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
            tray.setContextMenu(buildMenu({ showMainWindow, createWindow, getBrowserUrl, requestQuit }));
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

  currentHomeDir = readHomeDirectoryConfig();

  tray.setToolTip("Prime-Silo");
  const refreshMenu = () => tray && tray.setContextMenu(buildMenu(options));
  refreshMenu();

  // Rebuild on open so the Memo-Ray line reflects the latest resolved port.
  tray.on("click", () => {
    options.showMainWindow();
    options.createWindow();
  });
  tray.on("right-click", refreshMenu);

  return tray;
}

function destroyDesktopTray() {
  if (tray) {
    try {
      tray.destroy();
    } catch {
      // ignore
    }
    tray = null;
  }
}

module.exports = { createDesktopTray, destroyDesktopTray };
