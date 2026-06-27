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
// Text-sprite labels are an optional second module; loaded best-effort so the
// scene still renders (just without floating names) if the CDN is blocked.
const DEFAULT_SPRITE_CDN_URL = "https://esm.sh/three-spritetext@1";
const DEFAULT_BACKGROUND = "#0b1220";
const DEFAULT_NODE_REL_SIZE = 4;
const DEFAULT_LINK_COLOR = "rgba(148, 163, 184, 0.55)";
const DEFAULT_NODE_COLOR = "#94a3b8";
const DEFAULT_LABEL_COLOR = "rgba(232, 236, 233, 0.92)";
// Default force tuning. 3d-force-graph ships with a weak charge (-30) and a
// short link distance, which packs nodes into unreadable clumps. These push
// clusters apart so labels stop overlapping. Overridable via options.
const DEFAULT_CHARGE_STRENGTH = -120;
const DEFAULT_LINK_DISTANCE = 45;

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

// Last path segment, so a File node reads "auth.py" instead of the full
// "/src/app/services/auth.py". Trailing slashes are trimmed first.
function basename(value) {
  const str = String(value).replace(/[\\/]+$/, "");
  const seg = str.split(/[\\/]/).pop();
  return seg || str;
}

function looksLikePath(value) {
  return typeof value === "string" && /[\\/]/.test(value) && !/\s/.test(value);
}

// Friendly name for a node, unified across the three graph shapes (kept in
// sync with force_graph_2d's labelFor):
//   • kg3d (Documents): display_name → canonical_name → …
//   • codegraph (Code): name → label → path(basename) → …
//   • memoray (Memory): content / label / type
export function labelFor(entry) {
  const safe = entry && typeof entry === "object" ? entry : {};
  const node = safe.node && typeof safe.node === "object" ? safe.node : {};
  const named =
    node.display_name ||
    node.canonical_name ||
    node.name ||
    node.title ||
    node.label ||
    node.content ||
    safe.label;
  if (named) return basename(String(named).trim());
  const path = node.path || safe.path;
  if (path) return basename(path);
  const id = safe.id || node.id;
  if (id != null) return looksLikePath(id) ? basename(id) : String(id);
  return node.type || safe.type || "node";
}

// Full identifier (path / canonical name / id) for the hover tooltip, so the
// friendly label never costs the ability to tell two similar nodes apart.
export function identifierFor(entry) {
  const safe = entry && typeof entry === "object" ? entry : {};
  const node = safe.node && typeof safe.node === "object" ? safe.node : {};
  return String(node.path || node.canonical_name || node.id || safe.id || "");
}

/**
 * Convert a widget layout (kg3d or codegraph shape) into the 3d-force-graph
 * `{ nodes, links }` payload. Exported for testing.
 */
export function layoutToGraphData(layout, physicsMode = "pinned") {
  const positions =
    layout && typeof layout === "object" && layout.positions ? layout.positions : {};
  const edgesRaw = layout && Array.isArray(layout.edges) ? layout.edges : [];

  const nodes = Object.entries(positions).map(([id, entry]) => {
    const safe = entry && typeof entry === "object" ? entry : {};
    const node = {
      id,
      color: typeof safe.color === "string" && safe.color ? safe.color : DEFAULT_NODE_COLOR,
      // `val` drives the default node size in 3d-force-graph. Pre-computed
      // radii from the 2D layout map directly so the visual weight scales
      // the same way under both renderers.
      val: typeof safe.radius === "number" ? safe.radius : 1,
      // Friendly name for the floating label / hover tooltip; full identifier
      // for the tooltip's second line.
      name: labelFor(safe),
      ident: identifierFor(safe)
    };
    // Seed the force layout with the SVG-layout coordinates.
    // If physicsMode is "pinned", we fix/pin the X and Y coordinates.
    // Otherwise (if "fluid"), we only set node.x and node.y as initial seeding
    // values and let the 3D solver move them.
    if (physicsMode === "pinned") {
      if (typeof safe.x === "number") node.fx = safe.x;
      if (typeof safe.y === "number") node.fy = safe.y;
    } else {
      if (typeof safe.x === "number") node.x = safe.x;
      if (typeof safe.y === "number") node.y = safe.y;
    }
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

/**
 * Filter predicate shared by the 2D fallback's intent and the 3D scene.
 * Currently the only renderer-level filter is `focusedLayer` (kg3d): when
 * set, nodes outside that AoT layer are hidden. Code-graph type filtering
 * happens upstream in the widget's layout (filtered types never reach the
 * renderer), so it needs no handling here. Exported for testing.
 */
export function nodeMatchesProps(node, props) {
  if (!node || !props) return true;
  const focus = props.focusedLayer;
  if (focus && node.layer != null && node.layer !== focus) return false;
  return true;
}

function linkMatchesProps(link, props) {
  if (!link || !props) return true;
  const s = link.source;
  const t = link.target;
  // After 3d-force-graph processes graphData, endpoints are node objects;
  // before that they're ids. Only filter once we can read the node's layer.
  const sourceOk = s && typeof s === "object" ? nodeMatchesProps(s, props) : true;
  const targetOk = t && typeof t === "object" ? nodeMatchesProps(t, props) : true;
  return sourceOk && targetOk;
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
  const cdnUrl =
    typeof options.cdnUrl === "string" && options.cdnUrl ? options.cdnUrl : DEFAULT_CDN_URL;
  const loader =
    typeof options.loader === "function" ? options.loader : () => defaultLoader(cdnUrl);
  const backgroundColor =
    typeof options.backgroundColor === "string" ? options.backgroundColor : DEFAULT_BACKGROUND;
  const nodeRelSize =
    typeof options.nodeRelSize === "number" ? options.nodeRelSize : DEFAULT_NODE_REL_SIZE;
  const fallbackLinkColor =
    typeof options.linkColor === "string" ? options.linkColor : DEFAULT_LINK_COLOR;
  const onNodeClick = typeof options.onNodeClick === "function" ? options.onNodeClick : null;
  const physicsMode = typeof options.physicsMode === "string" ? options.physicsMode : "pinned";
  // After the force layout settles, frame the whole graph in the viewport.
  // Without this the camera sits at 3d-force-graph's fixed default distance,
  // so any graph larger than that default spills off the frame — the bug this
  // renderer exhibited on the code graph and the dense semantic-triples graph.
  const fitOnLoad = options.fitOnLoad === false ? false : true;
  const fitPaddingPx = typeof options.fitPaddingPx === "number" ? options.fitPaddingPx : 60;
  const fitDurationMs = typeof options.fitDurationMs === "number" ? options.fitDurationMs : 600;
  // Floating 3D text labels. On by default; needs the optional spritetext
  // module (lazy-loaded from its own CDN, separate from 3d-force-graph).
  const showLabels = options.showLabels === false ? false : true;
  const spriteCdnUrl =
    typeof options.spriteCdnUrl === "string" && options.spriteCdnUrl
      ? options.spriteCdnUrl
      : DEFAULT_SPRITE_CDN_URL;
  const labelLoader =
    typeof options.labelLoader === "function" ? options.labelLoader : () => defaultLoader(spriteCdnUrl);
  const labelColor =
    typeof options.labelColor === "string" ? options.labelColor : DEFAULT_LABEL_COLOR;
  // Force-layout spacing. Stronger (more negative) charge + longer links push
  // dense clusters apart so labels stop colliding.
  const chargeStrength =
    typeof options.chargeStrength === "number" ? options.chargeStrength : DEFAULT_CHARGE_STRENGTH;
  const linkDistance =
    typeof options.linkDistance === "number" ? options.linkDistance : DEFAULT_LINK_DISTANCE;

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
      pending: { layout, props },
      // Set whenever new data is applied; cleared once the camera has framed
      // the settled graph (on the next `onEngineStop`). Re-framing per data
      // change keeps the whole graph in view as it grows or is filtered.
      needsFit: fitOnLoad,
      resizeObserver: null
    };

    function applyData() {
      if (state.disposed || !state.instance) return;
      const data = layoutToGraphData(state.pending.layout, physicsMode);
      if (physicsMode === "fluid") {
        for (const node of data.nodes) {
          if (node.layer != null) {
            node.fy = (5 - node.layer) * 50;
          }
        }
      }
      // New data reheats the force engine; ask for a re-fit once it settles.
      if (fitOnLoad) state.needsFit = true;
      state.instance.graphData(data);
      applyFilters();
    }

    // Frame all nodes in the viewport. Guarded — minimal lib stubs (and the
    // node-runner test double) don't implement zoomToFit.
    function fitToView() {
      if (state.disposed || !state.instance) return;
      if (typeof state.instance.zoomToFit === "function") {
        state.instance.zoomToFit(fitDurationMs, fitPaddingPx);
      }
    }

    // Keep the WebGL canvas sized to its host. 3d-force-graph only listens for
    // window resizes, so panel/split resizes (the cockpit's Expand toggle,
    // dragging the Observe split) would otherwise leave a stale canvas size
    // and the graph clipped at the frame edge.
    function syncSize() {
      if (state.disposed || !state.instance || !state.host) return;
      const w = state.host.clientWidth;
      const h = state.host.clientHeight;
      if (typeof state.instance.width === "function" && w) state.instance.width(w);
      if (typeof state.instance.height === "function" && h) state.instance.height(h);
    }

    // Re-apply the visibility accessors so filters (e.g. focusedLayer) take
    // effect without a remount. The accessors read the live `state.pending`
    // props, so re-registering them is enough to re-evaluate. Guarded so the
    // contract still holds against a minimal lib stub lacking these setters.
    function applyFilters() {
      if (state.disposed || !state.instance) return;
      const props = state.pending && state.pending.props ? state.pending.props : {};
      if (typeof state.instance.nodeVisibility === "function") {
        state.instance.nodeVisibility((n) => nodeMatchesProps(n, props));
      }
      if (typeof state.instance.linkVisibility === "function") {
        state.instance.linkVisibility((l) => linkMatchesProps(l, props));
      }
    }

    Promise.resolve()
      .then(() => loader())
      .then((ForceGraph3D) => {
        if (state.disposed) return;
        if (typeof ForceGraph3D !== "function") {
          throw new Error("three-renderer: loader did not return a ForceGraph3D constructor.");
        }
        // 3d-force-graph's curried API: ForceGraph3D()(domElement)
        const instance = ForceGraph3D()(state.host);
        instance
          .backgroundColor(backgroundColor)
          .nodeRelSize(nodeRelSize)
          .nodeColor((n) => (n && n.color) || DEFAULT_NODE_COLOR)
          .linkColor((l) => (l && l.color) || fallbackLinkColor);
        // Hover tooltip — friendly name plus the full identifier when it
        // differs. Cheap, works even if the text-sprite module never loads.
        if (typeof instance.nodeLabel === "function") {
          instance.nodeLabel((n) => {
            if (!n) return "";
            const name = escapeHtml(String(n.name || n.id || ""));
            const ident = n.ident && n.ident !== n.name ? escapeHtml(String(n.ident)) : "";
            return ident ? `<strong>${name}</strong><br><span style="opacity:.7">${ident}</span>` : `<strong>${name}</strong>`;
          });
        }
        // Spread dense clusters so labels don't pile up. d3Force returns the
        // underlying force; guarded for minimal lib stubs.
        if (typeof instance.d3Force === "function") {
          const charge = instance.d3Force("charge");
          if (charge && typeof charge.strength === "function") charge.strength(chargeStrength);
          const link = instance.d3Force("link");
          if (link && typeof link.distance === "function") link.distance(linkDistance);
        }
        // Floating text labels via the optional spritetext module. Best-effort:
        // only attempted when the lib supports custom node objects, and never
        // blocks the scene if the sprite CDN fails. The hover tooltip above
        // remains as the fallback.
        if (showLabels && typeof instance.nodeThreeObject === "function") {
          Promise.resolve()
            .then(() => labelLoader())
            .then((SpriteText) => {
              if (state.disposed || !state.instance || typeof SpriteText !== "function") return;
              instance.nodeThreeObject((node) => {
                const text = node && (node.name || node.id);
                if (!text) return null;
                const sprite = new SpriteText(String(text));
                sprite.color = labelColor;
                sprite.textHeight = 4;
                sprite.fontWeight = "500";
                // Lift the label clear of the node sphere so they don't overlap.
                sprite.position.set(0, (node.val || 1) + 6, 0);
                return sprite;
              });
              // Keep the colored sphere AND show the label beside it.
              if (typeof instance.nodeThreeObjectExtend === "function") {
                instance.nodeThreeObjectExtend(true);
              }
            })
            .catch(() => {
              /* labels are optional — silently fall back to hover tooltip */
            });
        }
        if (onNodeClick) {
          instance.onNodeClick((n) => {
            if (!n) return;
            onNodeClick(n.id, n);
          });
        }
        // Frame the graph once the layout cools. onEngineStop fires after the
        // initial layout and again after every reheat (each graphData call),
        // so the `needsFit` flag gates it to one fit per data change.
        if (fitOnLoad && typeof instance.onEngineStop === "function") {
          instance.onEngineStop(() => {
            if (state.needsFit) {
              state.needsFit = false;
              fitToView();
            }
          });
        }
        state.instance = instance;
        syncSize();
        applyData();
        // Track host resizes so the canvas (and framing) follow panel layout
        // changes, not just window resizes.
        if (typeof ResizeObserver === "function" && state.host) {
          state.resizeObserver = new ResizeObserver(() => {
            syncSize();
            fitToView();
          });
          state.resizeObserver.observe(state.host);
        }
      })
      .catch((err) => {
        if (state.disposed || !state.host) return;
        // Surface a small inline error inside the host so the widget's
        // ambient "ready" state isn't visually empty. The default SVG
        // renderer was already replaced by the renderer hook; without
        // this, a failed CDN fetch would leave a blank canvas.
        state.host.innerHTML = `<div class="prime-silo-three-renderer__error">3D renderer failed: ${escapeHtml(err && err.message ? err.message : String(err))}</div>`;
      });

    return {
      update(nextLayout, nextProps) {
        state.pending = { layout: nextLayout, props: nextProps };
        applyData();
      },
      dispose() {
        state.disposed = true;
        if (state.resizeObserver && typeof state.resizeObserver.disconnect === "function") {
          try {
            state.resizeObserver.disconnect();
          } catch (_e) {
            /* swallow */
          }
          state.resizeObserver = null;
        }
        if (state.instance && typeof state.instance._destructor === "function") {
          // 3d-force-graph exposes _destructor() for teardown of the
          // Three.js scene + WebGL context. Wrap in try/catch — a partial
          // mount (host removed mid-load) is the most common failure path.
          try {
            state.instance._destructor();
          } catch (_e) {
            /* swallow */
          }
        }
        state.instance = null;
        if (state.host) {
          // The widget's destroy() clears innerHTML too, but if the
          // renderer is being torn down while the widget stays alive (the
          // caller swapped renderers), this keeps the host tidy.
          try {
            state.host.innerHTML = "";
          } catch (_e) {
            /* swallow */
          }
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
