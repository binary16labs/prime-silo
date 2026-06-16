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
const { app, Tray, Menu, shell, nativeImage } = require("electron");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const LOCK_FILENAME = "apps.lock.json";
const LOCK_SCHEMA = "aamp.lock/1";

let tray = null;

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
