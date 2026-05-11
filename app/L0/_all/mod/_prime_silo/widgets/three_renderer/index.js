// ADR-001 Phase C follow-up — Three.js drop-in renderer.
//
// Slots into `kg3d.synoptic_web` and `codegraph.canvas` via the
// `options.renderer = { mount, update, dispose }` hook that Phase C
// established as the pluggable-renderer contract. The widget cores stay
// dependency-free (default 2D SVG); callers that want a 3D scene pass an
// instance returned by `createThreeRenderer()` and the widget never
// learns Three.js exists.
//
// ## Lazy-loading strategy
//
// Three.js is heavy. Bundling it into the shell would tax every page that
// imports a graph widget, even pages that never enable the 3D renderer.
// The strategy:
//
//   1. The renderer **module** itself has no top-level import of
//      Three.js / 3d-force-graph. Importing it is free.
//   2. The first call to `mount()` triggers a dynamic `import()` of
//      `3d-force-graph` from a CDN ESM endpoint
//      (`https://esm.sh/3d-force-graph@1` by default). The bundle is
//      cached by the browser after the first load.
//   3. While the import is in flight, the mount call returns a handle
//      synchronously so the widget contract is preserved. Subsequent
//      `update(layout, props)` calls before the import resolves are
//      stashed and replayed once the library is ready. `dispose()` before
//      the import resolves cancels the activation so nothing renders.
//
// Tests pass `options.loader = () => Promise<ForceGraph3D>` to inject a
// stub — the node test runner never touches the CDN. The loader is also
// the seam through which production callers can pin a specific
// `3d-force-graph` version or load from a self-hosted bundle.
//
// ## Layout contract
//
// The widget's `paint(layout)` flow calls `mount/update` with the layout
// already computed (positions keyed by id, an edges array). The renderer
// normalises both widget shapes:
//
//   • `kg3d.synoptic_web`  → positions carry { x, y, radius, layer, color, node }
//                            edges carry { id, source, target, kind, weight }
//   • `codegraph.canvas`   → positions carry { x, y, radius, type, color, node }
//                            edges carry { id, source, target, type, metadata }
//
// `layoutToGraphData(layout)` walks `Object.entries(positions)` to build
// nodes (preserving the SVG-layout coordinates as `fx`/`fy` initial
// positions — the 3D force layout iterates from there instead of starting
// from random) and walks `edges` to build links. The original entries
// from the widget's `positions[id].node` are carried through on
// `node._original` for callers that need them on hover.
//
// ## Public API
//
//   createThreeRenderer(options?) -> { mount, dispose }
//     options.loader            — () => Promise<ForceGraph3D constructor>
//     options.cdnUrl            — overrides the default CDN URL
//     options.backgroundColor   — scene background (default "#0b1220")
//     options.nodeRelSize       — passed through to 3d-force-graph
//     options.linkColor         — fallback link colour
//
//   mount(host, layout, props) -> handle { update, dispose }
//     Synchronous return. The handle's update / dispose route through to
//     the underlying 3d-force-graph instance once loaded.

const DEFAULT_CDN_URL = "https://esm.sh/3d-force-graph@1";
const DEFAULT_BACKGROUND = "#0b1220";
const DEFAULT_NODE_REL_SIZE = 4;
const DEFAULT_LINK_COLOR = "rgba(148, 163, 184, 0.55)";
const DEFAULT_NODE_COLOR = "#94a3b8";

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

function escapeHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Convert a widget layout (kg3d or codegraph shape) into the 3d-force-graph
 * `{ nodes, links }` payload. Exported for testing.
 */
export function layoutToGraphData(layout) {
  const positions = layout && typeof layout === "object" && layout.positions
    ? layout.positions
    : {};
  const edgesRaw = layout && Array.isArray(layout.edges) ? layout.edges : [];

  const nodes = Object.entries(positions).map(([id, entry]) => {
    const safe = entry && typeof entry === "object" ? entry : {};
    const node = {
      id,
      color: typeof safe.color === "string" && safe.color ? safe.color : DEFAULT_NODE_COLOR,
      // `val` drives the default node size in 3d-force-graph. Pre-computed
      // radii from the 2D layout map directly so the visual weight scales
      // the same way under both renderers.
      val: typeof safe.radius === "number" ? safe.radius : 1
    };
    // Seed the force layout with the SVG-layout coordinates. fx/fy pin the
    // initial X/Y; the 3D solver then settles Z. This keeps the visual
    // grouping (AoT layers / type bands) recognisable between renderers.
    if (typeof safe.x === "number") node.fx = safe.x;
    if (typeof safe.y === "number") node.fy = safe.y;
    if (safe.layer != null) node.layer = safe.layer;
    if (safe.type != null) node.type = safe.type;
    // Stash the original node payload so renderer-specific hover/click
    // handlers can read metadata without re-keying through the layout.
    if (safe.node) node._original = safe.node;
    return node;
  });

  const links = edgesRaw
    .filter((edge) => edge && edge.source != null && edge.target != null)
    .map((edge) => {
      const link = {
        source: String(edge.source),
        target: String(edge.target)
      };
      if (typeof edge.color === "string" && edge.color) link.color = edge.color;
      // The widgets use different terms — kg3d says "kind", codegraph says
      // "type". Preserve both so renderer styling can branch on either.
      if (edge.type != null) link.type = edge.type;
      if (edge.kind != null) link.kind = edge.kind;
      if (typeof edge.weight === "number") link.weight = edge.weight;
      return link;
    });

  return { nodes, links };
}

async function defaultLoader(cdnUrl) {
  // Dynamic import so the CDN fetch only happens when a renderer actually
  // mounts. Modern bundlers leave bare specifiers alone; this string is
  // resolvable by the browser ESM loader directly.
  const mod = await import(/* @vite-ignore */ cdnUrl);
  return (mod && (mod.default || mod.ForceGraph3D || mod)) || null;
}

/**
 * Build a renderer instance compatible with the widget pluggable-renderer
 * hook. The returned object exposes `mount` (which the widget calls); the
 * handle returned by `mount` exposes `update` and `dispose`.
 *
 * Multiple mounts off the same factory are supported: each mount returns
 * its own independent handle backed by its own 3d-force-graph instance.
 */
export function createThreeRenderer(options = {}) {
  const cdnUrl = typeof options.cdnUrl === "string" && options.cdnUrl
    ? options.cdnUrl
    : DEFAULT_CDN_URL;
  const loader = typeof options.loader === "function"
    ? options.loader
    : () => defaultLoader(cdnUrl);
  const backgroundColor = typeof options.backgroundColor === "string"
    ? options.backgroundColor
    : DEFAULT_BACKGROUND;
  const nodeRelSize = typeof options.nodeRelSize === "number"
    ? options.nodeRelSize
    : DEFAULT_NODE_REL_SIZE;
  const fallbackLinkColor = typeof options.linkColor === "string"
    ? options.linkColor
    : DEFAULT_LINK_COLOR;
  const onNodeClick = typeof options.onNodeClick === "function"
    ? options.onNodeClick
    : null;

  function mount(host, layout, props) {
    if (!host || typeof host.querySelector !== "function") {
      throw new Error("createThreeRenderer.mount: host must be an HTMLElement.");
    }
    // Per-mount state. No closure over factory state — multiple concurrent
    // mounts must not clobber each other.
    const state = {
      host,
      instance: null,
      disposed: false,
      // Updates that arrive before the CDN import resolves are stashed
      // here and replayed on activation. We only keep the latest layout —
      // a 3D scene only needs the most recent state, not the history.
      pending: { layout, props }
    };

    function applyData() {
      if (state.disposed || !state.instance) return;
      const data = layoutToGraphData(state.pending.layout);
      state.instance.graphData(data);
    }

    Promise.resolve()
      .then(() => loader())
      .then((ForceGraph3D) => {
        if (state.disposed) return;
        if (typeof ForceGraph3D !== "function") {
          throw new Error(
            "three-renderer: loader did not return a ForceGraph3D constructor."
          );
        }
        // 3d-force-graph's curried API: ForceGraph3D()(domElement)
        const instance = ForceGraph3D()(state.host);
        instance
          .backgroundColor(backgroundColor)
          .nodeRelSize(nodeRelSize)
          .nodeColor((n) => (n && n.color) || DEFAULT_NODE_COLOR)
          .linkColor((l) => (l && l.color) || fallbackLinkColor);
        if (onNodeClick) {
          instance.onNodeClick((n) => {
            if (!n) return;
            onNodeClick(n.id, n);
          });
        }
        state.instance = instance;
        applyData();
      })
      .catch((err) => {
        if (state.disposed || !state.host) return;
        // Surface a small inline error inside the host so the widget's
        // ambient "ready" state isn't visually empty. The default SVG
        // renderer was already replaced by the renderer hook; without
        // this, a failed CDN fetch would leave a blank canvas.
        state.host.innerHTML =
          `<div class="prime-silo-three-renderer__error">3D renderer failed: ${escapeHtml(err && err.message ? err.message : String(err))}</div>`;
      });

    return {
      update(nextLayout, nextProps) {
        state.pending = { layout: nextLayout, props: nextProps };
        applyData();
      },
      dispose() {
        state.disposed = true;
        if (state.instance && typeof state.instance._destructor === "function") {
          // 3d-force-graph exposes _destructor() for teardown of the
          // Three.js scene + WebGL context. Wrap in try/catch — a partial
          // mount (host removed mid-load) is the most common failure path.
          try { state.instance._destructor(); } catch (_e) { /* swallow */ }
        }
        state.instance = null;
        if (state.host) {
          // The widget's destroy() clears innerHTML too, but if the
          // renderer is being torn down while the widget stays alive (the
          // caller swapped renderers), this keeps the host tidy.
          try { state.host.innerHTML = ""; } catch (_e) { /* swallow */ }
        }
        state.host = null;
      }
    };
  }

  return { mount };
}

export const __testing = {
  DEFAULT_CDN_URL,
  DEFAULT_BACKGROUND,
  DEFAULT_NODE_REL_SIZE,
  DEFAULT_LINK_COLOR,
  DEFAULT_NODE_COLOR
};
