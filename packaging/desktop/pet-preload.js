// Minimal, locked-down bridge for the desktop-pet window. Exposes only the two
// actions the pet UI needs; no Node surface reaches the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("benny", {
  openCockpit: (action) => ipcRenderer.send("space-desktop:pet-open-cockpit", action),
  hide: () => ipcRenderer.send("space-desktop:pet-hide")
});
