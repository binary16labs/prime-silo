// C1 — adaptive layout contract: the shared PaneContract helper.
//
// Canvas/WebGL graph widgets (force_graph_2d, three_renderer) must know
// their host's real pixel box and re-measure it on every pane resize — a
// split drag, a fullscreen toggle, a window resize, a panel that just
// became visible. Before C1 each widget hand-rolled its own
// `ResizeObserver` + `window.addEventListener("resize", …)` pair with no
// debounce, so a drag-resize fired a callback on every intermediate frame.
// This is the one place that logic lives now.
//
// SVG-only widgets (kg3d.synoptic_web, dag.canvas, codegraph.canvas) do NOT
// need this — their `<svg viewBox>` + CSS `width:100%;height:100%` already
// scales declaratively with zero JS.
//
//   createPaneContract(host, onResize, options?) -> { dispose() }
//     host       — element to observe (getBoundingClientRect required;
//                  ResizeObserver/window listeners are best-effort and
//                  skipped when unavailable, e.g. the node test runner).
//     onResize   — ({ width, height }) => void, debounced.
//     options.debounceMs — default 80 (one call per settled drag-resize).
//     options.immediate  — default true: fire once synchronously so callers
//                  don't wait a full debounce window for the first size.

const DEFAULT_DEBOUNCE_MS = 80;

function hasRect(el) {
  return !!el && typeof el.getBoundingClientRect === "function";
}

export function createPaneContract(host, onResize, options = {}) {
  const debounceMs =
    typeof options.debounceMs === "number" ? options.debounceMs : DEFAULT_DEBOUNCE_MS;
  const immediate = options.immediate !== false;

  let disposed = false;
  let timer = null;
  let observer = null;
  let win = null;
  let onWinResize = null;

  function measureAndFire() {
    if (disposed || typeof onResize !== "function" || !hasRect(host)) return;
    const rect = host.getBoundingClientRect();
    onResize({ width: rect.width, height: rect.height });
  }

  function scheduleFire() {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      measureAndFire();
    }, debounceMs);
  }

  if (typeof ResizeObserver !== "undefined" && host) {
    observer = new ResizeObserver(() => scheduleFire());
    observer.observe(host);
  }

  // Window maximize/restore doesn't always re-fire ResizeObserver on a
  // flex-sized child, so listen for it directly as a belt-and-braces.
  if (host && host.ownerDocument && host.ownerDocument.defaultView) {
    win = host.ownerDocument.defaultView;
    onWinResize = () => scheduleFire();
    win.addEventListener("resize", onWinResize);
  }

  if (immediate) measureAndFire();

  return {
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (observer) {
        try {
          observer.disconnect();
        } catch {
          /* swallow */
        }
        observer = null;
      }
      if (win && onWinResize) {
        try {
          win.removeEventListener("resize", onWinResize);
        } catch {
          /* swallow */
        }
        win = null;
        onWinResize = null;
      }
    }
  };
}
