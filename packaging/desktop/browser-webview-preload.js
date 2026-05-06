const { contextBridge, ipcRenderer } = require("electron");
const {
  DOM_HELPER_CHANNEL,
  DOM_HELPER_FLAG,
  DOM_HELPER_KEY,
  DOM_HELPER_TIMEOUT_MS,
  installBrowserDomHelper
} = require("./browser-dom-helper.js");

const DESKTOP_BROWSER_WEBVIEW_ENVELOPE_CHANNEL = "space.web_browsing.browser_frame";
const DESKTOP_BROWSER_TRANSPORT_KEY = "__spaceBrowserEmbedTransport__";
const DESKTOP_BROWSER_TRANSPORT_RECEIVE_EVENT = "__spaceBrowserDesktopEnvelope__";
const DESKTOP_BROWSER_TRANSPORT_SEND_EVENT = "__spaceBrowserDesktopEnvelopeSend__";

function sendDebugEnvelopeToHost(type, payload = null) {
  try {
    ipcRenderer.sendToHost(DESKTOP_BROWSER_WEBVIEW_ENVELOPE_CHANNEL, {
      channel: DESKTOP_BROWSER_WEBVIEW_ENVELOPE_CHANNEL,
      phase: "event",
      type,
      payload
    });
  } catch (error) {
    console.error("[space-desktop/browser-webview-preload] Failed to emit debug envelope to host.", error);
  }
}

function dispatchEnvelopeToMainWorld(envelope) {
  if (typeof contextBridge?.executeInMainWorld !== "function") {
    return;
  }

  try {
    contextBridge.executeInMainWorld({
      func: function dispatchDesktopEnvelope(eventName, detail) {
        globalThis.dispatchEvent(new CustomEvent(eventName, {
          detail
        }));
      },
      args: [DESKTOP_BROWSER_TRANSPORT_RECEIVE_EVENT, envelope]
    });
  } catch (error) {
    console.error("[space-desktop/browser-webview-preload] Failed to dispatch browser envelope into the main world.", error);
  }
}

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
    console.error("[space-desktop/browser-webview-preload] Failed to install DOM helper.", error);
  }
}

ipcRenderer.on(DESKTOP_BROWSER_WEBVIEW_ENVELOPE_CHANNEL, (_event, envelope) => {
  sendDebugEnvelopeToHost("__preload_received__", {
    phase: String(envelope?.phase || ""),
    requestId: String(envelope?.requestId || ""),
    type: String(envelope?.type || "")
  });

  dispatchEnvelopeToMainWorld(envelope);
});

installDomHelper();

globalThis.addEventListener(DESKTOP_BROWSER_TRANSPORT_SEND_EVENT, (event) => {
  const envelope = event?.detail ?? null;
  console.info("[space-desktop/browser-webview-preload] Forwarding browser envelope to host.", {
    phase: String(envelope?.phase || ""),
    type: String(envelope?.type || "")
  });

  try {
    ipcRenderer.sendToHost(DESKTOP_BROWSER_WEBVIEW_ENVELOPE_CHANNEL, envelope);
  } catch (error) {
    console.error("[space-desktop/browser-webview-preload] Failed to forward browser envelope to host.", error);
  }
});

contextBridge.exposeInMainWorld(DESKTOP_BROWSER_TRANSPORT_KEY, {
  eventName: DESKTOP_BROWSER_TRANSPORT_RECEIVE_EVENT,
  receiveEventName: DESKTOP_BROWSER_TRANSPORT_RECEIVE_EVENT,
  sendEventName: DESKTOP_BROWSER_TRANSPORT_SEND_EVENT
});

sendDebugEnvelopeToHost("__preload_ready__", {
  isMainFrame: Boolean(process.isMainFrame),
  locationHref: String(globalThis.location?.href || ""),
  receiveEventName: DESKTOP_BROWSER_TRANSPORT_RECEIVE_EVENT,
  sendEventName: DESKTOP_BROWSER_TRANSPORT_SEND_EVENT
});
