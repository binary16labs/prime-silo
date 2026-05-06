const { contextBridge, ipcRenderer } = require("electron");
const {
  DOM_HELPER_CHANNEL,
  DOM_HELPER_FLAG,
  DOM_HELPER_KEY,
  DOM_HELPER_TIMEOUT_MS,
  installBrowserDomHelper
} = require("./browser-dom-helper.js");

const DESKTOP_BROWSER_ENVELOPE_FROM_MAIN_CHANNEL = "space-desktop:browser-envelope-to-view";
const DESKTOP_BROWSER_ENVELOPE_TO_MAIN_CHANNEL = "space-desktop:browser-envelope-from-view";
const DESKTOP_BROWSER_TRANSPORT_KEY = "__spaceBrowserEmbedTransport__";

let receiveEnvelope = null;

function installDomHelper() {
  if (typeof contextBridge?.executeInMainWorld !== "function") {
    return;
  }

  try {
    contextBridge.executeInMainWorld({
      func: installBrowserDomHelper,
      args: [DOM_HELPER_FLAG, DOM_HELPER_KEY, DOM_HELPER_CHANNEL, DOM_HELPER_TIMEOUT_MS]
    });
  } catch (error) {
    console.error("[space-desktop/browser-preload] Failed to install DOM helper.", error);
  }
}

ipcRenderer.on(DESKTOP_BROWSER_ENVELOPE_FROM_MAIN_CHANNEL, (_event, payload = {}) => {
  try {
    receiveEnvelope?.(payload.envelope);
  } catch (error) {
    console.error("[space-desktop/browser-preload] Failed to deliver browser envelope.", error);
  }
});

installDomHelper();

contextBridge.exposeInMainWorld(DESKTOP_BROWSER_TRANSPORT_KEY, {
  bindReceiver(listener) {
    receiveEnvelope = typeof listener === "function" ? listener : null;

    return () => {
      if (receiveEnvelope === listener) {
        receiveEnvelope = null;
      }
    };
  },

  sendEnvelope(envelope) {
    ipcRenderer.send(DESKTOP_BROWSER_ENVELOPE_TO_MAIN_CHANNEL, {
      envelope
    });
  }
});
