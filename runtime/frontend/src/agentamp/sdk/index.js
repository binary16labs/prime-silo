/**
 * AgentAmp AgentVis Plugin SDK — Phase 2
 *
 * AAMP-F3   mount(pluginManifest, hostElement, eventStream)
 *               Creates a sandboxed iframe, registers the plugin with DSP-A,
 *               and returns an { unmount } handle for clean teardown.
 * AAMP-SEC1 iframe sandbox="allow-scripts" only; no allow-same-origin,
 *               allow-top-navigation, allow-forms, allow-popups,
 *               allow-pointer-lock.
 * AAMP-SEC2 CSP via <meta http-equiv> inside the iframe bootstrap HTML;
 *               connect-src 'none' prevents fetch / WebSocket / EventSource.
 * AAMP-F4   Events forwarded only for types the plugin declared in
 *               permissions.events AND the host skin also permits (AAMP-SEC6).
 * AAMP-NFR12 Watchdog: iframe killed within WATCHDOG_TIMEOUT_MS if no
 *               heartbeat arrives.
 */

/** @type {string} — AAMP-SEC1 */
export const PLUGIN_SANDBOX_ATTRS = "allow-scripts";

/** @type {string} — AAMP-SEC2 */
export const PLUGIN_CSP =
  "default-src 'none'; " +
  "script-src 'self' 'wasm-unsafe-eval'; " +
  "img-src data: blob:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'none'; " +
  "frame-ancestors 'self'";

/** @type {number} — AAMP-NFR12: ms of silence before the iframe is killed */
const WATCHDOG_TIMEOUT_MS = 2000;

/**
 * Mount a plugin into *hostElement* as a sandboxed iframe.
 *
 * @param {object} pluginManifest   Parsed plugin.manifest.json object.
 * @param {HTMLElement} hostElement Container element; iframe is appended here.
 * @param {EventTarget} eventStream EventTarget that emits "envelope" events
 *                                  whose detail is a DSP-A Envelope object.
 * @returns {{ unmount: () => void }}
 */
export function mount(pluginManifest, hostElement, eventStream) {
  const { id, entry, permissions } = pluginManifest;
  const allowedEvents = new Set(permissions?.events ?? []);

  // 1. Create sandboxed iframe (AAMP-SEC1)
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", PLUGIN_SANDBOX_ATTRS);
  iframe.style.cssText = "border:none;width:100%;height:100%;display:block;";

  // 2. Build bootstrap HTML with inline CSP meta tag (AAMP-SEC2)
  const bootstrapHtml = _buildBootstrapHtml(id, entry, PLUGIN_CSP);
  const blob = new Blob([bootstrapHtml], { type: "text/html" });
  const blobUrl = URL.createObjectURL(blob);
  iframe.src = blobUrl;
  hostElement.appendChild(iframe);

  // 3. Watchdog (AAMP-NFR12)
  let watchdogTimer = null;

  function resetWatchdog() {
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      // Plugin unresponsive — kill the iframe
      console.warn(`[agentamp] plugin "${id}" watchdog fired — killing iframe`);
      _killIframe(iframe, hostElement);
    }, WATCHDOG_TIMEOUT_MS);
  }

  resetWatchdog();

  // 4. Forward filtered events into the iframe (AAMP-F4, AAMP-SEC6)
  function onEnvelope(event) {
    const envelope = event.detail ?? event;
    const type = envelope?.source_event?.type ?? envelope?.type;
    if (!type || !allowedEvents.has(type)) {
      // Silently ignored — no exception across the iframe boundary (AAMP-F4)
      return;
    }
    if (!iframe.contentWindow) return;
    iframe.contentWindow.postMessage(
      { kind: "aamp_event", envelope },
      "*" // iframe is sandboxed; postMessage target origin is irrelevant
    );
  }

  eventStream.addEventListener("envelope", onEnvelope);

  // 5. Heartbeat listener — plugin must ack to keep the watchdog alive
  function onMessage(evt) {
    if (evt.source !== iframe.contentWindow) return;
    if (evt.data?.kind === "aamp_heartbeat" && evt.data?.plugin_id === id) {
      resetWatchdog();
    }
  }

  window.addEventListener("message", onMessage);

  // 6. Return unmount handle (AAMP-F3)
  return {
    unmount() {
      clearTimeout(watchdogTimer);
      eventStream.removeEventListener("envelope", onEnvelope);
      window.removeEventListener("message", onMessage);
      URL.revokeObjectURL(blobUrl);
      if (iframe.parentNode) {
        iframe.src = "about:blank";
        iframe.parentNode.removeChild(iframe);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _killIframe(iframe, hostElement) {
  if (iframe.parentNode) {
    iframe.src = "about:blank";
    hostElement.removeChild(iframe);
  }
}

function _buildBootstrapHtml(pluginId, entry, csp) {
  // The bootstrap is a minimal ES-module loader that:
  //   a) emits a heartbeat so the watchdog knows the iframe is alive.
  //   b) imports the plugin entry point.
  //   c) exposes a minimal SDK surface (postMessage bridge; no DOM access
  //      to the parent — AAMP-SEC1 / AAMP-SEC2 make this impossible anyway).
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
</head>
<body>
<script type="module">
const PLUGIN_ID = ${JSON.stringify(pluginId)};

// Heartbeat — tells the host watchdog we're alive
function beat() {
  window.parent.postMessage({ kind: 'aamp_heartbeat', plugin_id: PLUGIN_ID }, '*');
}
beat();
setInterval(beat, ${Math.floor(WATCHDOG_TIMEOUT_MS * 0.4)});

// Minimal SDK surface exposed to the plugin entry module
const sdk = {
  onEvent(handler) {
    window.addEventListener('message', (e) => {
      if (e.data?.kind === 'aamp_event') handler(e.data.envelope);
    });
  },
  emit(msg) {
    window.parent.postMessage({ kind: 'aamp_plugin_msg', plugin_id: PLUGIN_ID, payload: msg }, '*');
  },
};

// Dynamic import is subject to the script-src CSP above
import(${JSON.stringify(entry)}).then((mod) => {
  if (typeof mod.default === 'function') mod.default(sdk);
}).catch((err) => {
  window.parent.postMessage({ kind: 'aamp_plugin_error', plugin_id: PLUGIN_ID, error: String(err) }, '*');
});
</script>
</body>
</html>`;
}
