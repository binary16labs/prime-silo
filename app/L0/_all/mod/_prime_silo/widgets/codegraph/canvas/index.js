// ADR-001 Phase C — `codegraph.canvas` widget.
//
// Read-only Tree-Sitter-derived file/class/function graph for a
// workspace. Eighth migrated widget under Phase C and the **last** Phase
// C widget — completes the canvas migration. Sourced from the runtime's
// `/graph/code` endpoint; same renderer-pluggability pattern as
// `kg3d.synoptic_web`.
//
// ## Renderer dependency decision (recap)
//
// The upstream `CodeGraphCanvas.tsx` is a Three.js R3F scene. Migrating
// it wholesale would mean dragging Three.js + R3F into the dependency-
// free shell — too heavy for a first migration. Same pragmatic line as
// `kg3d.synoptic_web`:
//
//   1. Default renderer is a 2D SVG layered graph: Folders/Files on the
//      left bands, then Classes, then Functions/Modules on the right.
//      Edge style follows upstream colour conventions
//      (DEFINES = white, INHERITS = green, CALLS = orange dashed,
//      DEPENDS_ON = cyan dashed, CORRELATES_WITH = magenta dashed).
//      No CDN, no build step.
//   2. Renderer is pluggable via `options.renderer = { mount, update,
//      dispose }`. A future `three-renderer.js` slots in without
//      touching the widget contract; tests inject a stub the same way.
//
// Public API
//   createCodeGraphCanvasWidget(host, props, options)
//     props   — {
//       workspace?: string,        // default "default"
//       snapshotId?: string,       // pin to a specific scan
//       pathFilter?: string,       // ?path= prefix filter
//       selectedNodeId?: string,
//       visibleTypes?: string[],   // Folder, File, Module, Class, Function, Concept
//       onSelect?: (nodeId) => void,
//       data?: { nodes, edges }    // optional inline data — skips fetch
//     }
//     options — {
//       runtimeClient?: { runtimeFetch, readRuntimeJson },
//       renderer?: { mount, update, dispose }
//     }
//
// Returns { update, refresh, destroy, get layout, get rawGraph }.

import {
  runtimeFetch,
  readRuntimeJson
} from "../../../runtime_client/runtime-client.js";

const STATE_LOADING = "loading";
const STATE_READY = "ready";
const STATE_ERROR = "error";

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

// Match the upstream CodeGraphCanvas palette so a future 3D renderer
// composes with the same visual language.
const NODE_TYPE_COLORS = {
  Folder: "#FFD700",
  File: "#00FFFF",
  Module: "#94a3b8",
  Class: "#007ACC",
  Function: "#FF5F1F",
  Concept: "#a78bfa",
  default: "#64748b"
};

const EDGE_TYPE_COLORS = {
  DEFINES: "#ffffff",
  INHERITS: "#39FF14",
  CALLS: "#FF5F1F",
  DEPENDS_ON: "#00FFFF",
  CORRELATES_WITH: "#ec4899",
  REL: "#94a3b8",
  default: "rgba(148, 163, 184, 0.6)"
};

const DASHED_EDGE_TYPES = new Set(["CALLS", "DEPENDS_ON", "CORRELATES_WITH"]);

const DEFAULT_VISIBLE_TYPES = ["Folder", "File", "Module", "Class", "Function", "Concept"];

// Bands, left → right. Folders/Files anchor on the structural left;
// Concepts (enrichment overlay) push to the rightmost band so they sit
// next to the symbols they correlate with.
const TYPE_BAND_INDEX = {
  Folder: 0,
  File: 1,
  Module: 2,
  Class: 3,
  Function: 4,
  Concept: 5
};

const BAND_WIDTH = 160;
const BAND_GAP = 32;
const NODE_RADIUS = 6;
const NODE_VERTICAL_GAP = 22;
const TOP_PADDING = 28;
const BOTTOM_PADDING = 28;
const LEFT_PADDING = 18;
const SVG_MIN_HEIGHT = 240;

function buildCodeGraphPath(props) {
  const params = new URLSearchParams();
  params.set("workspace", props.workspace || "default");
  if (props.snapshotId) params.set("snapshot_id", props.snapshotId);
  if (props.pathFilter) params.set("path", props.pathFilter);
  return `/graph/code?${params.toString()}`;
}

function ensureClient(options) {
  if (options && options.runtimeClient) {
    return options.runtimeClient;
  }
  return { runtimeFetch, readRuntimeJson };
}

function pickNodeColor(type) {
  if (type && NODE_TYPE_COLORS[type]) return NODE_TYPE_COLORS[type];
  return NODE_TYPE_COLORS.default;
}

function pickEdgeColor(type) {
  if (type && EDGE_TYPE_COLORS[type]) return EDGE_TYPE_COLORS[type];
  return EDGE_TYPE_COLORS.default;
}

function bandIndexFor(type) {
  if (type && Object.prototype.hasOwnProperty.call(TYPE_BAND_INDEX, type)) {
    return TYPE_BAND_INDEX[type];
  }
  return TYPE_BAND_INDEX.Module;
}

function nodeLabel(node) {
  if (!node) return "(node)";
  return node.name || node.label || node.path || node.id || "(node)";
}

/**
 * Compute layered code-graph layout.
 *
 * Buckets nodes into vertical bands by type (Folder→Concept). Within a
 * band, nodes are sorted by `path` (when present) for stable ordering,
 * then stacked. Edges that point at filtered-out nodes are dropped.
 *
 * Returns { positions, edges, width, height, buckets }.
 */
export function computeLayout(nodes, edges, props = {}) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const safeEdges = Array.isArray(edges) ? edges : [];
  const visibleSet = new Set(
    Array.isArray(props.visibleTypes) && props.visibleTypes.length > 0
      ? props.visibleTypes
      : DEFAULT_VISIBLE_TYPES
  );

  const bandsArray = [[], [], [], [], [], []];
  for (const node of safeNodes) {
    const type = node && node.type;
    if (!visibleSet.has(type)) continue;
    bandsArray[bandIndexFor(type)].push(node);
  }
  // Stable sort within bands.
  for (const bucket of bandsArray) {
    bucket.sort((a, b) => {
      const ka = (a.path || a.name || a.id || "").toString();
      const kb = (b.path || b.name || b.id || "").toString();
      return ka.localeCompare(kb);
    });
  }

  let activeBands = 0;
  let maxRows = 0;
  bandsArray.forEach((bucket) => {
    if (bucket.length > 0) activeBands += 1;
    if (bucket.length > maxRows) maxRows = bucket.length;
  });

  const positions = {};
  // Re-index bands so empty leading bands don't push everything right.
  const bandRenderIndex = [];
  let nextRenderIdx = 0;
  bandsArray.forEach((bucket, idx) => {
    bandRenderIndex[idx] = bucket.length > 0 ? nextRenderIdx++ : -1;
  });

  bandsArray.forEach((bucket, bandIdx) => {
    const renderIdx = bandRenderIndex[bandIdx];
    if (renderIdx < 0) return;
    const bandX = LEFT_PADDING + renderIdx * (BAND_WIDTH + BAND_GAP) + BAND_WIDTH / 2;
    bucket.forEach((node, row) => {
      const y = TOP_PADDING + row * NODE_VERTICAL_GAP;
      positions[node.id] = {
        x: bandX,
        y,
        radius: NODE_RADIUS,
        color: pickNodeColor(node.type),
        type: node.type,
        node
      };
    });
  });

  const renderedEdges = [];
  for (const edge of safeEdges) {
    const sourceId = edge.source != null ? String(edge.source) : null;
    const targetId = edge.target != null ? String(edge.target) : null;
    if (!sourceId || !targetId) continue;
    if (sourceId === targetId) continue;
    if (!positions[sourceId] || !positions[targetId]) continue;
    renderedEdges.push({
      id: edge.id || `${sourceId}->${targetId}`,
      source: sourceId,
      target: targetId,
      type: edge.type || "default",
      metadata: edge.metadata || null
    });
  }

  const width = activeBands === 0
    ? LEFT_PADDING * 2 + BAND_WIDTH
    : LEFT_PADDING * 2 + activeBands * BAND_WIDTH + Math.max(0, activeBands - 1) * BAND_GAP;
  const height = Math.max(
    SVG_MIN_HEIGHT,
    TOP_PADDING + Math.max(0, maxRows - 1) * NODE_VERTICAL_GAP + BOTTOM_PADDING + 16
  );

  return { positions, edges: renderedEdges, width, height, buckets: bandsArray, bandRenderIndex };
}

function bandLabelForIndex(idx) {
  const inverse = Object.entries(TYPE_BAND_INDEX).find(([, v]) => v === idx);
  return inverse ? inverse[0] : "";
}

function renderBandLabels(layout) {
  const labels = [];
  layout.bandRenderIndex.forEach((renderIdx, bandIdx) => {
    if (renderIdx < 0) return;
    const x = LEFT_PADDING + renderIdx * (BAND_WIDTH + BAND_GAP) + BAND_WIDTH / 2;
    labels.push(`<text class="prime-silo-cg__band-label" x="${x}" y="14" text-anchor="middle">${escapeHtml(bandLabelForIndex(bandIdx))}</text>`);
  });
  return labels.join("");
}

function renderEdgeSvg(edge, positions) {
  const s = positions[edge.source];
  const t = positions[edge.target];
  if (!s || !t) return "";
  const color = pickEdgeColor(edge.type);
  const dashed = DASHED_EDGE_TYPES.has(edge.type);
  const strokeWidth = edge.type === "INHERITS" ? 1.8 : 1.2;
  return `<path class="prime-silo-cg__edge" data-edge-type="${escapeHtml(edge.type)}" d="M ${s.x} ${s.y} C ${(s.x + t.x) / 2} ${s.y}, ${(s.x + t.x) / 2} ${t.y}, ${t.x} ${t.y}" stroke="${color}" stroke-width="${strokeWidth}" ${dashed ? 'stroke-dasharray="4 3"' : ""} fill="none" />`;
}

function renderNodeSvg(positionEntry, props) {
  const { x, y, radius, color, type, node } = positionEntry;
  const selected = node.id === props.selectedNodeId;
  const label = nodeLabel(node);
  return `
    <g class="prime-silo-cg__node" data-node-id="${escapeHtml(node.id)}" data-node-type="${escapeHtml(type || "")}"${selected ? ' data-selected="true"' : ""}>
      <title>${escapeHtml(label)}${type ? ` · ${escapeHtml(type)}` : ""}</title>
      <circle cx="${x}" cy="${y}" r="${radius}" fill="${color}" stroke="${selected ? "#f8fafc" : "rgba(15,23,42,0.85)"}" stroke-width="${selected ? 2.5 : 1.2}" />
      <text class="prime-silo-cg__node-label" x="${x + radius + 6}" y="${y + 3}">${escapeHtml(label)}</text>
    </g>
  `;
}

export function renderSvg(layout, props) {
  const { positions, edges, width, height } = layout;
  const bandLabels = renderBandLabels(layout);
  const edgeSvg = edges.map((e) => renderEdgeSvg(e, positions)).join("");
  const nodeSvg = Object.values(positions)
    .map((entry) => renderNodeSvg(entry, props))
    .join("");
  return `
    <svg class="prime-silo-cg__svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <g class="prime-silo-cg__band-labels">${bandLabels}</g>
      <g class="prime-silo-cg__edges">${edgeSvg}</g>
      <g class="prime-silo-cg__nodes">${nodeSvg}</g>
    </svg>
  `;
}

function renderError(host, error) {
  const detail = (error && (error.body && error.body.detail || error.message)) || String(error);
  host.dataset.widgetState = STATE_ERROR;
  host.innerHTML = `<div class="prime-silo-cg__error">Code graph load failed: ${escapeHtml(detail)}</div>`;
}

function renderLoading(host, props) {
  host.dataset.widgetState = STATE_LOADING;
  host.innerHTML = `<div class="prime-silo-cg__loading">Loading code graph for workspace ${escapeHtml(props.workspace || "default")}…</div>`;
}

function renderEmpty(host, props) {
  host.dataset.widgetState = STATE_READY;
  host.innerHTML = `<div class="prime-silo-cg__empty">No code-graph nodes for workspace <code>${escapeHtml(props.workspace || "default")}</code>. Run <code>benny enrich --src &lt;dir&gt;</code> or trigger a tree-sitter scan to populate the graph.</div>`;
}

/**
 * Mount the codegraph.canvas widget into `host`.
 */
export function createCodeGraphCanvasWidget(host, initialProps, options = {}) {
  if (!host || typeof host.querySelector !== "function") {
    throw new Error("createCodeGraphCanvasWidget: host must be an HTMLElement.");
  }

  const client = ensureClient(options);
  const customRenderer = options && options.renderer ? options.renderer : null;
  let props = { ...initialProps };
  let aborted = false;
  let lastLayout = null;
  let lastGraph = null;
  let rendererHandle = null;

  host.classList.add("prime-silo-cg");

  function onClick(event) {
    const target = event.target && event.target.closest && event.target.closest("[data-node-id]");
    if (!target) return;
    const nodeId = target.getAttribute("data-node-id");
    if (typeof props.onSelect === "function") {
      props.onSelect(nodeId);
    }
  }

  if (typeof host.addEventListener === "function") {
    host.addEventListener("click", onClick);
  }

  function paint(layout) {
    if (customRenderer) {
      if (rendererHandle && typeof rendererHandle.update === "function") {
        rendererHandle.update(layout, props);
        return;
      }
      rendererHandle = customRenderer.mount(host, layout, props);
      host.dataset.widgetState = STATE_READY;
      return;
    }
    host.dataset.widgetState = STATE_READY;
    host.innerHTML = renderSvg(layout, props);
  }

  async function load() {
    renderLoading(host, props);
    try {
      let payload;
      if (props.data && (props.data.nodes || props.data.edges)) {
        payload = { nodes: props.data.nodes || [], edges: props.data.edges || [] };
      } else {
        const response = await client.runtimeFetch(buildCodeGraphPath(props));
        payload = await client.readRuntimeJson(response);
      }
      if (aborted) return;
      const nodes = (payload && Array.isArray(payload.nodes)) ? payload.nodes : [];
      const edges = (payload && Array.isArray(payload.edges)) ? payload.edges : [];
      lastGraph = { nodes, edges };
      if (nodes.length === 0) {
        lastLayout = computeLayout([], [], props);
        renderEmpty(host, props);
        return;
      }
      lastLayout = computeLayout(nodes, edges, props);
      paint(lastLayout);
    } catch (err) {
      if (aborted) return;
      renderError(host, err);
    }
  }

  function update(nextProps) {
    const merged = { ...props, ...nextProps };
    const fetchKeyChanged =
      merged.workspace !== props.workspace ||
      merged.snapshotId !== props.snapshotId ||
      merged.pathFilter !== props.pathFilter ||
      (merged.data || null) !== (props.data || null);
    const visibilityChanged =
      JSON.stringify(merged.visibleTypes || null) !==
      JSON.stringify(props.visibleTypes || null);
    props = merged;
    if (fetchKeyChanged) {
      load();
      return;
    }
    if (visibilityChanged && lastGraph) {
      lastLayout = computeLayout(lastGraph.nodes, lastGraph.edges, props);
      paint(lastLayout);
      return;
    }
    if (lastLayout) {
      paint(lastLayout);
    }
  }

  function refresh() {
    return load();
  }

  function destroy() {
    aborted = true;
    if (typeof host.removeEventListener === "function") {
      host.removeEventListener("click", onClick);
    }
    if (rendererHandle && typeof rendererHandle.dispose === "function") {
      try { rendererHandle.dispose(); } catch (_e) { /* swallow */ }
    }
    rendererHandle = null;
    host.classList.remove("prime-silo-cg");
    host.innerHTML = "";
    delete host.dataset.widgetState;
  }

  load();

  return {
    update,
    refresh,
    destroy,
    get layout() {
      return lastLayout;
    },
    get rawGraph() {
      return lastGraph;
    }
  };
}

export const __testing = {
  buildCodeGraphPath,
  computeLayout,
  renderSvg,
  renderEdgeSvg,
  renderNodeSvg,
  pickNodeColor,
  pickEdgeColor,
  bandIndexFor,
  nodeLabel,
  NODE_TYPE_COLORS,
  EDGE_TYPE_COLORS,
  DASHED_EDGE_TYPES,
  TYPE_BAND_INDEX,
  DEFAULT_VISIBLE_TYPES
};
