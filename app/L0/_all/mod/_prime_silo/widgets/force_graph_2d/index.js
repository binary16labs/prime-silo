// Organic 2D force-graph drop-in renderer.
//
// Slots into `memoray.lineage_graph`, `kg3d.synoptic_web`, and
// `codegraph.canvas` via the same `options.renderer = { mount, update,
// dispose }` hook that `three_renderer` uses. The widget cores stay
// dependency-free (default 2D SVG); callers that want the living, organic
// graph — the Memo-Ray look (force-simulated motion, node glow, animated
// trace particles on the active path, a corner minimap) — pass an instance
// returned by `createForceGraph2DRenderer()` and the widget never learns the
// graphing library exists.
//
// ## Offline by design
//
// Unlike `three_renderer` (which lazy-loads `3d-force-graph` from a CDN), the
// 2D library is **vendored locally** at `vendor/force-graph.module.js` (a
// self-contained esbuild bundle of vasturiano/force-graph with every d3 /
// lodash dependency inlined — zero bare imports, see vendor/README.md). The
// default loader dynamic-imports that local path, so the renderer works with
// no network at all. The import is still lazy (only on first mount) so pages
// that never open a graph pay nothing.
//
// Tests inject `options.loader = () => Promise<ForceGraph>` so the node runner
// never touches the vendored bundle or the DOM.
//
// ## Layout contract (shared with three_renderer)
//
//   • `memoray.lineage_graph` → positions carry { x, y, depth, node }
//   • `kg3d.synoptic_web`     → positions carry { x, y, radius, layer, color, node }
//   • `codegraph.canvas`      → positions carry { x, y, radius, type, color, node }
//
// `layoutToGraphData(layout, physics)` normalises all three into the
// `{ nodes, links }` shape force-graph expects. Lineage positions carry no
// colour/radius, so colour is derived from the node's `type` via the Memo-Ray
// palette and size from a per-type default. `physics === "pinned"` fixes
// fx/fy (frozen layout); `"fluid"` only seeds x/y and lets the simulation run
// (the organic motion).
//
// ## Click / hover
//
// Both conventions are honoured: the per-mount `props.onSelect(id)` used by
// the SVG renderers, and the factory `options.onNodeClick(id, node)` used by
// the Bridge's `makeThreeRenderer`-style wiring. Whichever is present fires.

import { createPaneContract } from "../pane_contract.js";

const DEFAULT_VENDOR_URL = new URL("./vendor/force-graph.module.js", import.meta.url).href;
const DEFAULT_BACKGROUND = "transparent";

// Memo-Ray organic palette, by node type (mirrors OrganicGraph.jsx PALETTE
// and lineage_graph's NODE_TYPE_COLORS — earth tones, sage/moss/golden).
const PALETTE = {
  "User Input": "#b8a898",
  Thought: "#8b9c8b",
  Message: "#8b9c8b",
  "Tool Call": "#6a8a6a",
  "Tool Result": "#6a8a6a",
  Artifact: "#8a9aa4",
  Session: "#c4a882",
  "System Init": "#5a6a5e",
  Error: "#c47a6a"
};
const DEFAULT_NODE_COLOR = "#6b7378";
const HIGHLIGHT_COLOR = "#db533f"; // rust red, matches Memo-Ray
const LINK_COLOR = "rgba(138,154,164,0.12)";
const LABEL_COLOR = "rgba(232,236,233,0.7)";
const DEFAULT_NODE_VAL = 6;
// force-graph ships a weak charge (-30) and short links, which packs nodes
// into clumps where labels overlap. Stronger repulsion + longer links open the
// clusters up so names are readable. Overridable via options.
const DEFAULT_CHARGE_STRENGTH = -180;
const DEFAULT_LINK_DISTANCE = 60;
// Node count above which the renderer switches to the lite profile (see
// createForceGraph2DRenderer options).
const LITE_NODE_THRESHOLD = 2000;

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function colorFor(entry) {
  if (entry && typeof entry.color === "string" && entry.color) return entry.color;
  const type = (entry && (entry.type || (entry.node && entry.node.type))) || null;
  return (type && PALETTE[type]) || DEFAULT_NODE_COLOR;
}

// Last path segment, so a File node reads "auth.py" on the canvas instead of
// the full "/src/app/services/auth.py". Trailing slashes are trimmed first.
function basename(value) {
  const str = String(value).replace(/[\\/]+$/, "");
  const seg = str.split(/[\\/]/).pop();
  return seg || str;
}

function looksLikePath(value) {
  return typeof value === "string" && /[\\/]/.test(value) && !/\s/.test(value);
}

// Human-readable label shown on the canvas. Mirrors the field priority each
// widget's own SVG renderer uses, unified across all three graph shapes:
//   • kg3d (Documents):  display_name → canonical_name → …
//   • codegraph (Code):  name → label → path(basename) → …
//   • memoray (Memory):  content / label / type
// so nodes never fall back to a raw id or bare type when a real name exists.
function labelFor(entry) {
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

// The full, unambiguous identifier — surfaced in the hover tooltip so the
// human-friendly canvas label never costs you the ability to tell two
// similarly-named nodes apart (e.g. two auth.py in different folders).
function identifierFor(entry) {
  const safe = entry && typeof entry === "object" ? entry : {};
  const node = safe.node && typeof safe.node === "object" ? safe.node : {};
  return String(node.path || node.canonical_name || node.id || safe.id || "");
}

/**
 * Convert a widget layout (lineage / kg3d / codegraph shape) into force-graph's
 * `{ nodes, links }` payload. Exported for testing.
 */
export function layoutToGraphData(layout, physicsMode = "fluid") {
  const positions =
    layout && typeof layout === "object" && layout.positions ? layout.positions : {};
  const edgesRaw = layout && Array.isArray(layout.edges) ? layout.edges : [];

  const nodes = Object.entries(positions).map(([id, entry]) => {
    const safe = entry && typeof entry === "object" ? entry : {};
    const type = safe.type || (safe.node && safe.node.type) || null;
    const node = {
      id,
      type,
      color: colorFor(safe),
      // `val` drives the node radius. Pre-computed radii from the 2D layout map
      // directly; lineage carries none, so fall back to a readable default.
      val: typeof safe.radius === "number" ? safe.radius : DEFAULT_NODE_VAL,
      // Friendly name for the canvas; full identifier for the hover tooltip.
      label: labelFor(safe),
      ident: identifierFor(safe)
    };
    if (physicsMode === "pinned") {
      if (typeof safe.x === "number") node.fx = safe.x;
      if (typeof safe.y === "number") node.fy = safe.y;
    } else {
      // Seed positions so the sim iterates from the layered layout instead of
      // exploding from random — the organic settle still happens, just from a
      // sane starting point.
      if (typeof safe.x === "number") node.x = safe.x;
      if (typeof safe.y === "number") node.y = safe.y;
    }
    if (safe.layer != null) node.layer = safe.layer;
    if (typeof safe.depth === "number") node.depth = safe.depth;
    if (safe.node) node._original = safe.node;
    return node;
  });

  const links = edgesRaw
    .filter((edge) => edge && edge.source != null && edge.target != null)
    .map((edge) => {
      const link = { source: String(edge.source), target: String(edge.target) };
      if (typeof edge.color === "string" && edge.color) link.color = edge.color;
      if (edge.type != null) link.type = edge.type;
      if (edge.kind != null) link.kind = edge.kind;
      if (typeof edge.weight === "number") link.weight = edge.weight;
      return link;
    });

  return { nodes, links };
}

/**
 * `focusedLayer` (kg3d) visibility predicate — shared with three_renderer's
 * semantics. Exported for testing.
 */
export function nodeMatchesProps(node, props) {
  if (!node || !props) return true;
  const focus = props.focusedLayer;
  if (focus && node.layer != null && node.layer !== focus) return false;
  return true;
}

// Which node id(s) are "in scope" — the active selection, glowing rust red.
function highlightIdsFromProps(props) {
  if (!props) return [];
  const ids = [];
  if (Array.isArray(props.highlightNodeIds)) ids.push(...props.highlightNodeIds);
  if (props.highlightNodeId) ids.push(props.highlightNodeId);
  if (props.selectedNodeId) ids.push(props.selectedNodeId);
  return ids.filter(Boolean).map(String);
}

async function defaultLoader(vendorUrl) {
  const mod = await import(/* @vite-ignore */ vendorUrl);
  return (mod && (mod.default || mod.ForceGraph || mod)) || null;
}

/**
 * Build a renderer instance compatible with the widget pluggable-renderer
 * hook. The returned object exposes `mount`; the handle returned by `mount`
 * exposes `update` and `dispose`. Multiple mounts off one factory are
 * independent — each owns its own force-graph instance.
 */
export function createForceGraph2DRenderer(options = {}) {
  const vendorUrl =
    typeof options.vendorUrl === "string" && options.vendorUrl
      ? options.vendorUrl
      : DEFAULT_VENDOR_URL;
  const loader =
    typeof options.loader === "function" ? options.loader : () => defaultLoader(vendorUrl);
  const backgroundColor =
    typeof options.backgroundColor === "string" ? options.backgroundColor : DEFAULT_BACKGROUND;
  const physicsMode = typeof options.physicsMode === "string" ? options.physicsMode : "fluid";
  const factoryOnNodeClick = typeof options.onNodeClick === "function" ? options.onNodeClick : null;
  const showMinimap = options.minimap !== false;
  const chargeStrength =
    typeof options.chargeStrength === "number" ? options.chargeStrength : DEFAULT_CHARGE_STRENGTH;
  const linkDistance =
    typeof options.linkDistance === "number" ? options.linkDistance : DEFAULT_LINK_DISTANCE;
  // Above this many nodes the renderer drops into a "lite" profile — no trace
  // particles, labels only when zoomed in or highlighted, node glow off, and the
  // simulation settles fast and stays put. This is the less-intensive fallback
  // that keeps the "Everything" (orphan dust) view usable without windowing.
  // `options.lite: true` forces it on; `false` forces it off.
  const liteThreshold =
    typeof options.liteThreshold === "number" ? options.liteThreshold : LITE_NODE_THRESHOLD;
  const forceLite = typeof options.lite === "boolean" ? options.lite : null;

  function mount(host, layout, props) {
    if (!host || typeof host.querySelector !== "function") {
      throw new Error("createForceGraph2DRenderer.mount: host must be an HTMLElement.");
    }

    const state = {
      host,
      inner: null, // absolutely-positioned layer force-graph mounts into
      instance: null,
      disposed: false,
      highlight: highlightIdsFromProps(props),
      minimapCanvas: null,
      minimapTimer: null,
      paneContract: null,
      lastW: 0,
      lastH: 0,
      hasFitted: false,
      refitTimer: null,
      lite: false,
      pending: { layout, props }
    };

    function isHot(id) {
      return state.highlight.includes(String(id));
    }

    // ── node paint (ported from OrganicGraph.jsx) ──
    function paintNode(node, ctx, globalScale) {
      const hot = isHot(node.id);
      const color = hot ? HIGHLIGHT_COLOR : node.color || DEFAULT_NODE_COLOR;
      const size = (node.val || DEFAULT_NODE_VAL) * (hot ? 2.2 : 1);

      ctx.save();
      // Node glow is a per-frame cost; in lite mode keep it only for highlighted
      // nodes so a huge graph doesn't repaint thousands of shadow blurs.
      if (hot || (!state.lite && (node.type === "Session" || node.type === "Artifact"))) {
        ctx.shadowColor = hot ? HIGHLIGHT_COLOR : color;
        ctx.shadowBlur = hot ? 36 : 12;
      }
      ctx.beginPath();
      if (node.type === "Artifact") {
        const r = size * 0.4;
        const x = node.x - size;
        const y = node.y - size;
        const w = size * 2;
        const h = size * 2;
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
      } else {
        ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
      }
      ctx.fillStyle = color;
      ctx.globalAlpha = hot ? 1 : 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(size * 0.12, 0.5);
      ctx.strokeStyle = hot
        ? "rgba(255,255,255,0.9)"
        : `rgba(232,236,233,${node.type === "Session" ? 0.4 : 0.15})`;
      ctx.stroke();
      ctx.restore();

      if (hot) {
        ctx.save();
        ctx.beginPath();
        const pulse = Math.sin(Date.now() / 250) * 0.5 + 0.5;
        const pulseRadius = size * (1.2 + pulse * 0.5);
        ctx.arc(node.x, node.y, pulseRadius, 0, 2 * Math.PI);
        ctx.strokeStyle = HIGHLIGHT_COLOR;
        ctx.lineWidth = 1.5 / globalScale;
        ctx.globalAlpha = 0.6 - pulse * 0.45;
        ctx.stroke();
        ctx.restore();
      }

      // Show labels sooner (was zoom > 1.2 — too late to read a docs/code graph
      // at a normal fit) and let a bit more text through so names aren't clipped
      // to nothing. Highlighted nodes always label.
      // In lite mode only label highlighted nodes or when zoomed right in — drawing
      // thousands of text runs every frame is the dominant cost on a large graph.
      const labelThreshold = state.lite ? 2.2 : 0.55;
      if (globalScale > labelThreshold || hot) {
        const fontSize = Math.max(11 / globalScale, 4.5);
        ctx.font = hot
          ? `bold ${fontSize + 1}px Inter, system-ui`
          : `500 ${fontSize}px Inter, system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = hot ? HIGHLIGHT_COLOR : LABEL_COLOR;
        const label = String(node.label || node.type || node.id);
        const maxChars = Math.max(12, Math.floor(28 * Math.min(globalScale / 1.5, 1.6)));
        const text = label.length > maxChars ? label.substring(0, maxChars) + "…" : label;
        ctx.fillText(text, node.x, node.y + size + 2);
      }
    }

    function linkHot(link) {
      const s = typeof link.source === "object" ? link.source.id : link.source;
      const t = typeof link.target === "object" ? link.target.id : link.target;
      return { s: isHot(s), t: isHot(t) };
    }

    function sizeToHost() {
      if (!state.instance || !state.host) return;
      if (typeof state.host.getBoundingClientRect !== "function") return;
      const rect = state.host.getBoundingClientRect();
      const w = Math.round(rect.width > 0 ? rect.width : 600);
      const h = Math.round(rect.height > 0 ? rect.height : 400);
      // Only push new dimensions when they actually changed. force-graph's own
      // canvas lives in an absolutely-positioned inner layer (so it can never
      // drive the host's height), but skipping no-op resizes keeps the
      // ResizeObserver from ever entering a measure→set→measure cycle.
      if (w === state.lastW && h === state.lastH) return;
      state.lastW = w;
      state.lastH = h;
      if (typeof state.instance.width === "function") state.instance.width(w);
      if (typeof state.instance.height === "function") state.instance.height(h);
    }

    // A panel that just became visible (Alpine x-show display:none → block) is
    // often measured before layout flushes, so the very first getBoundingClientRect
    // can report a partial size — leaving the canvas stuck in a corner of the
    // frame. Re-measure across the next few frames so the canvas grows to fill
    // the stage once layout settles. (Mirrors OrganicGraph.jsx's rAF re-measure.)
    function scheduleResize() {
      sizeToHost();
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(sizeToHost);
      for (const delay of [60, 200, 450]) setTimeout(sizeToHost, delay);
    }

    // Re-frame the whole graph centered in the current viewport. force-graph
    // keeps the same world-center across a canvas resize, so without this the
    // content drifts to one side ("the graph says on the right") when the
    // window changes size. Debounced so a drag-resize settles to one refit, and
    // only fired on resize / first settle — NOT on data updates, so selecting a
    // node never yanks the camera.
    function refit(duration = 400) {
      if (!state.instance || typeof state.instance.zoomToFit !== "function") return;
      try {
        state.instance.zoomToFit(duration, 40);
      } catch {
        /* positions not ready yet */
      }
    }
    function scheduleRefit() {
      if (state.refitTimer) clearTimeout(state.refitTimer);
      state.refitTimer = setTimeout(() => refit(400), 220);
    }

    function applyData() {
      if (state.disposed || !state.instance) return;
      const data = layoutToGraphData(state.pending.layout, physicsMode);
      state.highlight = highlightIdsFromProps(state.pending.props);
      const props = state.pending.props || {};
      // Honour layer filtering by dropping hidden nodes/links before they reach
      // the sim (cheaper than per-frame visibility for a 2D canvas).
      const visibleNodes = data.nodes.filter((n) => nodeMatchesProps(n, props));
      const visibleIds = new Set(visibleNodes.map((n) => n.id));
      const visibleLinks = data.links.filter(
        (l) => visibleIds.has(String(l.source)) && visibleIds.has(String(l.target))
      );
      // Decide the render profile from the visible node count (or an explicit
      // override). In lite mode, let the sim settle fast and stop so a large graph
      // isn't perpetually reheating the CPU.
      state.lite = forceLite === null ? visibleNodes.length > liteThreshold : forceLite;
      if (typeof state.instance.warmupTicks === "function") {
        state.instance.warmupTicks(state.lite ? 8 : 50);
      }
      if (typeof state.instance.cooldownTime === "function") {
        state.instance.cooldownTime(state.lite ? 1200 : 3000);
      }
      state.instance.graphData({ nodes: visibleNodes, links: visibleLinks });
    }

    function fireClick(node) {
      if (!node) return;
      // The widgets pass a per-mount `props.onSelect`; the Bridge factory wiring
      // passes `options.onNodeClick`. Prefer the per-mount handler so the two
      // conventions don't double-fire when both are present (they route to the
      // same selection logic). Fall back to the factory handler otherwise.
      const onSelect = state.pending && state.pending.props && state.pending.props.onSelect;
      if (typeof onSelect === "function") onSelect(node.id, node._original || node);
      else if (factoryOnNodeClick) factoryOnNodeClick(node.id, node._original || node);
    }

    function fireHover(node) {
      const onHover = state.pending && state.pending.props && state.pending.props.onHover;
      if (typeof onHover === "function") onHover(node ? node.id : null, node);
    }

    function drawMinimap() {
      const cv = state.minimapCanvas;
      const inst = state.instance;
      if (!cv || !inst || state.disposed) return;
      const ctx = cv.getContext("2d");
      const W = cv.width;
      const H = cv.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "rgba(18,22,20,0.82)";
      ctx.fillRect(0, 0, W, H);
      const gd = typeof inst.graphData === "function" ? inst.graphData() : null;
      const nodes = (gd && gd.nodes ? gd.nodes : []).filter(
        (n) => typeof n.x === "number" && typeof n.y === "number"
      );
      if (!nodes.length) return;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const n of nodes) {
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      const pad = 6;
      const gw = maxX - minX || 1;
      const gh = maxY - minY || 1;
      const scale = Math.min((W - 2 * pad) / gw, (H - 2 * pad) / gh);
      const ox = (W - gw * scale) / 2;
      const oy = (H - gh * scale) / 2;
      const tx = (x) => ox + (x - minX) * scale;
      const ty = (y) => oy + (y - minY) * scale;
      for (const n of nodes) {
        const hot = isHot(n.id);
        ctx.beginPath();
        ctx.arc(tx(n.x), ty(n.y), hot ? 3 : 1, 0, 2 * Math.PI);
        ctx.fillStyle = hot ? HIGHLIGHT_COLOR : n.color || DEFAULT_NODE_COLOR;
        ctx.fill();
      }
      try {
        const c = typeof inst.centerAt === "function" ? inst.centerAt() : null;
        const k = typeof inst.zoom === "function" ? inst.zoom() : null;
        const rect = state.host.getBoundingClientRect();
        if (c && k && rect.width && rect.height) {
          const vw = rect.width / k;
          const vh = rect.height / k;
          ctx.strokeStyle = "rgba(232,236,233,0.55)";
          ctx.lineWidth = 1;
          ctx.strokeRect(tx(c.x - vw / 2), ty(c.y - vh / 2), vw * scale, vh * scale);
        }
      } catch {
        /* center/zoom not ready */
      }
    }

    Promise.resolve()
      .then(() => loader())
      .then((ForceGraph) => {
        if (state.disposed) return;
        if (typeof ForceGraph !== "function") {
          throw new Error("force_graph_2d: loader did not return a ForceGraph constructor.");
        }
        // Mount force-graph into an absolutely-positioned inner layer rather
        // than the host itself. The canvas force-graph creates is a block
        // element; mounted directly into a host whose height is content-driven
        // (e.g. Memory mode's auto-sized grid row) it would size the host, which
        // re-sizes the canvas, … an infinite vertical-growth loop ("the page
        // keeps scrolling down"). An inset:0 absolute layer takes its size from
        // the host and contributes nothing back, breaking the loop. Falls back
        // to mounting into the host directly when there's no real DOM (tests).
        let mountEl = state.host;
        if (
          state.host.ownerDocument &&
          typeof state.host.ownerDocument.createElement === "function" &&
          typeof state.host.appendChild === "function"
        ) {
          const inner = state.host.ownerDocument.createElement("div");
          inner.style.position = "absolute";
          inner.style.top = "0";
          inner.style.left = "0";
          inner.style.right = "0";
          inner.style.bottom = "0";
          inner.style.overflow = "hidden";
          state.host.appendChild(inner);
          state.inner = inner;
          mountEl = inner;
        }
        // force-graph's curried API: ForceGraph()(domElement)
        const instance = ForceGraph()(mountEl);
        instance
          .backgroundColor(backgroundColor)
          .nodeRelSize(DEFAULT_NODE_VAL)
          // Hover tooltip: the friendly name, its type, and — when it differs
          // from the name — the full identifier (path / canonical name / id),
          // so two similarly-named nodes are still tellable apart.
          .nodeLabel((n) => {
            if (!n) return "";
            const name = escapeHtml(String(n.label || n.id || ""));
            const type = n.type ? escapeHtml(String(n.type)) : "";
            const ident = n.ident && n.ident !== n.label ? escapeHtml(String(n.ident)) : "";
            const head = type
              ? `<strong>${name}</strong> <em>${type}</em>`
              : `<strong>${name}</strong>`;
            return ident ? `${head}<br><span style="opacity:.7">${ident}</span>` : head;
          })
          .nodeCanvasObject(paintNode)
          .nodePointerAreaPaint((node, color, ctx) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, (node.val || DEFAULT_NODE_VAL) * 1.5, 0, 2 * Math.PI);
            ctx.fill();
          })
          .linkColor((l) => {
            const { s, t } = linkHot(l);
            if (s && t) return "rgba(219,83,63,0.95)";
            if (s || t) return "rgba(219,83,63,0.4)";
            return l.color || LINK_COLOR;
          })
          .linkWidth((l) => {
            const { s, t } = linkHot(l);
            return s || t ? 3 : 1;
          })
          .linkDirectionalParticles((l) => {
            if (state.lite) return 0; // trace particles are per-frame animation cost
            const { s, t } = linkHot(l);
            return s || t ? 4 : 0;
          })
          .linkDirectionalParticleWidth((l) => {
            const { s, t } = linkHot(l);
            return s || t ? 4 : 2;
          })
          .linkDirectionalParticleSpeed((l) => {
            const { s, t } = linkHot(l);
            return s || t ? 0.015 : 0.004;
          })
          .d3VelocityDecay(0.25)
          .warmupTicks(50)
          .cooldownTime(3000)
          .onEngineStop(() => {
            // Frame the graph once, when the simulation first settles.
            if (!state.hasFitted) {
              state.hasFitted = true;
              refit(0);
            }
          })
          .onNodeClick((n) => fireClick(n))
          .onNodeHover((n) => fireHover(n))
          .onBackgroundClick(() => {
            const onBg =
              state.pending && state.pending.props && state.pending.props.onBackgroundClick;
            if (typeof onBg === "function") onBg();
          });
        // Open up dense clusters so labels stop overlapping (fluid mode only —
        // pinned nodes keep their fixed positions). Guarded for lib stubs.
        if (typeof instance.d3Force === "function") {
          const charge = instance.d3Force("charge");
          if (charge && typeof charge.strength === "function") charge.strength(chargeStrength);
          const link = instance.d3Force("link");
          if (link && typeof link.distance === "function") link.distance(linkDistance);
        }
        state.instance = instance;
        applyData();
        scheduleResize();

        // Keep the canvas filling the host through fullscreen / pane resizes,
        // and re-center the graph once the resize settles. C1: debounced via
        // the shared PaneContract helper (ResizeObserver + window-resize
        // belt-and-braces, one place instead of per-widget) rather than a raw
        // ResizeObserver firing on every intermediate drag-resize frame.
        state.paneContract = createPaneContract(
          state.host,
          () => {
            sizeToHost();
            scheduleRefit();
          },
          { immediate: false }
        );

        if (
          showMinimap &&
          state.host.ownerDocument &&
          typeof state.host.ownerDocument.createElement === "function" &&
          typeof state.host.appendChild === "function"
        ) {
          const cv = state.host.ownerDocument.createElement("canvas");
          cv.width = 210;
          cv.height = 140;
          cv.className = "prime-silo-fg2d__minimap";
          // Inline fallbacks so the minimap stays pinned (and never adds to the
          // host's content height) even if force_graph_2d.css didn't load.
          cv.style.position = "absolute";
          cv.style.bottom = "12px";
          cv.style.right = "12px";
          cv.style.zIndex = "10";
          cv.style.pointerEvents = "none";
          state.host.appendChild(cv);
          state.minimapCanvas = cv;
          state.minimapTimer = setInterval(drawMinimap, 300);
        }
      })
      .catch((err) => {
        if (state.disposed || !state.host) return;
        state.host.innerHTML = `<div class="prime-silo-fg2d__error">Graph renderer failed: ${escapeHtml(
          err && err.message ? err.message : String(err)
        )}</div>`;
      });

    // Camera-track the highlighted node: when props.track is set, pan the
    // viewport to the first highlighted node (used by the Step-Through player so
    // the free-floating graph follows the current step). Best-effort — positions
    // may not be settled yet on the first frames, so we retry briefly.
    function maybeCenterOnHighlight() {
      const p = state.pending && state.pending.props;
      if (!p || !p.track || !state.instance) return;
      const ids = highlightIdsFromProps(p);
      if (!ids.length) return;
      const tryCenter = () => {
        if (state.disposed || !state.instance) return false;
        const gd =
          typeof state.instance.graphData === "function" ? state.instance.graphData() : null;
        const node = gd && gd.nodes.find((n) => ids.includes(String(n.id)));
        if (node && typeof node.x === "number" && typeof state.instance.centerAt === "function") {
          state.instance.centerAt(node.x, node.y, 600);
          return true;
        }
        return false;
      };
      if (!tryCenter()) {
        for (const delay of [120, 400, 900]) setTimeout(tryCenter, delay);
      }
    }

    return {
      update(nextLayout, nextProps) {
        state.pending = { layout: nextLayout, props: nextProps };
        applyData();
        scheduleResize();
        maybeCenterOnHighlight();
      },
      dispose() {
        state.disposed = true;
        if (state.minimapTimer) {
          clearInterval(state.minimapTimer);
          state.minimapTimer = null;
        }
        if (state.refitTimer) {
          clearTimeout(state.refitTimer);
          state.refitTimer = null;
        }
        if (state.paneContract) {
          state.paneContract.dispose();
          state.paneContract = null;
        }
        if (state.instance && typeof state.instance._destructor === "function") {
          try {
            state.instance._destructor();
          } catch {
            /* swallow */
          }
        }
        state.instance = null;
        state.inner = null;
        if (state.host) {
          try {
            state.host.innerHTML = "";
          } catch {
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
  DEFAULT_VENDOR_URL,
  DEFAULT_BACKGROUND,
  PALETTE,
  HIGHLIGHT_COLOR,
  DEFAULT_NODE_COLOR,
  colorFor,
  labelFor,
  identifierFor,
  basename,
  highlightIdsFromProps
};
