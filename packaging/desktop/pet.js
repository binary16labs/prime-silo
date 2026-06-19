// Benny the desktop pet — a standalone, always-on-top, transparent, frameless
// window that floats the German Shepherd avatar over the whole desktop (Phase 4b
// of the Open-Studio plan). Independent of the cockpit window: it can show even
// before the Benny runtime is up, and clicking its chat button opens the cockpit.
//
// Self-contained on purpose. The pet's UI (pet.html) inlines its own copy of the
// avatar so it never depends on the server being reachable; that art mirrors
// app/L0/_all/mod/_core/visual/res/chat/overlay/dog_no_bg.svg.

const path = require("node:path");
const { BrowserWindow, ipcMain, screen } = require("electron");

const PET_SIZE = 184;
const PET_MARGIN = 24;

let petWindow = null;
// Captured at create() time; the IPC handlers (registered once below) read this.
let petDeps = {};

function createDesktopPet(deps = {}) {
  petDeps = deps || {};
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show();
    return petWindow;
  }

  // Bottom-right of the primary display's work area by default.
  const workArea = screen.getPrimaryDisplay().workArea;
  const x = workArea.x + workArea.width - PET_SIZE - PET_MARGIN;
  const y = workArea.y + workArea.height - PET_SIZE - PET_MARGIN;

  petWindow = new BrowserWindow({
    width: PET_SIZE,
    height: PET_SIZE,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: "Benny",
    webPreferences: {
      preload: path.join(__dirname, "pet-preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Float above ordinary windows (including most fullscreen apps).
  petWindow.setAlwaysOnTop(true, "screen-saver");
  if (typeof petWindow.setVisibleOnAllWorkspaces === "function") {
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  petWindow.loadFile(path.join(__dirname, "pet.html"));

  petWindow.on("closed", () => {
    petWindow = null;
  });

  return petWindow;
}

function destroyDesktopPet() {
  if (petWindow && !petWindow.isDestroyed()) {
    try {
      petWindow.close();
    } catch {
      // ignore
    }
  }
  petWindow = null;
}

function isDesktopPetVisible() {
  return Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible());
}

// Show if hidden, hide if shown. Returns the new visibility. `deps.onOpenCockpit`
// is forwarded so the pet's chat button can raise the main window.
function toggleDesktopPet(deps = {}) {
  if (isDesktopPetVisible()) {
    destroyDesktopPet();
    return false;
  }
  createDesktopPet(deps);
  return true;
}

// Registered once at module load (the module is required a single time from
// main.js). Using a module-level `petDeps` avoids stacking listeners on recreate.
ipcMain.on("space-desktop:pet-open-cockpit", () => {
  try {
    petDeps.onOpenCockpit?.();
  } catch {
    // ignore
  }
});
ipcMain.on("space-desktop:pet-hide", () => destroyDesktopPet());

module.exports = { createDesktopPet, destroyDesktopPet, toggleDesktopPet, isDesktopPetVisible };
