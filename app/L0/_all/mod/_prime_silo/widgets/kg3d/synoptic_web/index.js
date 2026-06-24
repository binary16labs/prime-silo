// ADR-001 Phase C — `kg3d.synoptic_web` widget.
//
// Read-only synoptic web of concept ontology nodes and edges, sourced from
// the runtime's `/kg3d/ontology` endpoint. Seventh migrated widget under
// Phase C; the second graph-shaped widget after `dag.canvas`.
//
// ## Renderer dependency decision
//
// The upstream `SynopticWeb.tsx` uses `react-force-graph-3d` + Three.js.
// Migrating that wholesale into the shell would mean bundling React +
// Three.js — a meaningful dependency for a read-only inspector. This
// migration takes a pragmatic line:
//
//   1. Ship a default **2D SVG layered renderer** that respects the AoT
//      layering (1 = abstract → 5 = concrete) and category palette. No
//      runtime dependency. Validates the data path end-to-end.
//   2. Keep the renderer **pluggable** via `options.renderer`. A future
//      `three-renderer.js` can lazy-import Three.js (or `3d-force-graph`)
//      from a CDN ESM and slot in without touching the widget core. The
//      same hook lets tests inject a stub.
//
// Honest trade-off: this is *not yet* a 3D synoptic web in the shell —
// the widget id keeps the historic name because the ontology contract
// and intent are identical. Upgrading to 3D is a follow-up; the data
// path needs to land first.
//
// Public API
//   createSynopticWebWidget(host, props, options)
//     props   — {
//       workspace?: string,        // default "default"
//       focusedLayer?: number,     // 1..5 — fade other AoT layers
//       selectedNodeId?: string,
//       onSelect?: (nodeId) => void,
//       data?: { nodes, edges }    // optional inline data — skips fetch
//     }
//     options — {
//       runtimeClient?: { runtimeFetch, readRuntimeJson },
//       renderer?: { mount(host, layout, props), update(layout, props), dispose() }
//     }
//
// Returns { update, refresh, destroy, get layout }.

import { runtimeFetch, readRuntimeJson } from "../../../runtime_client/runtime-client.js";

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

// AoT layering — layer 1 is most abstract, layer 5 is most concrete.
// The synoptic-web rendering puts abstract on top, concrete on bottom.
const MIN_LAYER = 1;
const MAX_LAYER = 5;
const DEFAULT_LAYER = 3;

// Subset of upstream palette — keeps the renderer dependency-free. The
// full palette lives in `runtime/frontend/src/components/Studio/kg3d/palette.ts`;
// the shell mirrors the most-used categories and falls back to a neutral
// colour for unknown ones.
const CATEGORY_COLORS = {
  ai_deep_learning: "#a78bfa",
  neural_evolutionary_computing: "#22d3ee",
  calc_variations_control: "#34d399",
  linear_multilinear_algebra_matrix_theory: "#fb923c",
  optimisation_reinforcement_learning: "#f472b6",
  default: "#94a3b8"
};

const EDGE_COLORS = {
  prerequisite: "rgba(99, 102, 241, 0.55)",
  references: "rgba(148, 163, 184, 0.45)",
  default: "rgba(148, 163, 184, 0.45)"
};

const LAYER_GAP = 90;
const NODE_RADIUS_BASE = 6;
const NODE_RADIUS_SCALE = 18;
const HORIZONTAL_PADDING = 32;
const TOP_PADDING = 28;
const BOTTOM_PADDING = 28;
const SVG_WIDTH = 720;

function pickCategoryColor(category) {
  if (category && CATEGORY_COLORS[category]) {
    return CATEGORY_COLORS[category];
  }
  return CATEGORY_COLORS.default;
}

function pickEdgeColor(kind) {
  if (kind && EDGE_COLORS[kind]) {
    return EDGE_COLORS[kind];
  }
  return EDGE_COLORS.default;
}

function buildOntologyPath(props) {
  const params = new URLSearchParams();
  params.set("workspace", props.workspace || "default");
  return `/kg3d/ontology?${params.toString()}`;
}

function ensureClient(options) {
  if (options && options.runtimeClient) {
    return options.runtimeClient;
  }
  return { runtimeFetch, readRuntimeJson };
}

function clampLayer(layer) {
  if (typeof layer !== "number" || Number.isNaN(layer)) return DEFAULT_LAYER;
  if (layer < MIN_LAYER) return MIN_LAYER;
  if (layer > MAX_LAYER) return MAX_LAYER;
  return Math.round(layer);
}

function pageRankWeight(node) {
  const pr =
    node && node.metrics && typeof node.metrics.pagerank === "number" ? node.metrics.pagerank : 0;
  // Pagerank in the test fixtures is normalised 0..100; clamp so a single
  // dominant node doesn't blow out the radius.
  return Math.max(0, Math.min(1, pr / 100));
}

/**
 * Compute layered layout. Nodes are bucketed by `aot_layer`; within a
 * layer they're spaced evenly across the available width. Returns a map
 * of nodeId → { x, y, radius, color } plus the bounding height.
 */
export function computeLayout(nodes, edges) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const safeEdges = Array.isArray(edges) ? edges : [];

  const buckets = new Map();
  for (let l = MIN_LAYER; l <= MAX_LAYER; l += 1) buckets.set(l, []);
  for (const node of safeNodes) {
    const layer = clampLayer(node && node.aot_layer);
    buckets.get(layer).push(node);
  }

  const positions = {};
  buckets.forEach((bucketNodes, layer) => {
    const count = bucketNodes.length;
    if (count === 0) return;
    const innerWidth = SVG_WIDTH - HORIZONTAL_PADDING * 2;
    const step = count === 1 ? 0 : innerWidth / (count - 1);
    bucketNodes.forEach((node, idx) => {
      const x = HORIZONTAL_PADDING + (count === 1 ? innerWidth / 2 : idx * step);
      const y = TOP_PADDING + (layer - MIN_LAYER) * LAYER_GAP;
      const weight = pageRankWeight(node);
      const radius = NODE_RADIUS_BASE + weight * NODE_RADIUS_SCALE;
      positions[node.id] = {
        x,
        y,
        radius,
        layer,
        color: pickCategoryColor(node.category),
        node
      };
    });
  });

  const renderedEdges = [];
  for (const edge of safeEdges) {
    const sourceId = edge.source_id || edge.source;
    const targetId = edge.target_id || edge.target;
    if (!sourceId || !targetId) continue;
    if (!positions[sourceId] || !positions[targetId]) continue;
    if (sourceId === targetId) continue;
    renderedEdges.push({
      id: edge.id || `${sourceId}->${targetId}`,
      source: sourceId,
      target: targetId,
      kind: edge.kind || "references",
      weight: typeof edge.weight === "number" ? edge.weight : 1
    });
  }

  const totalLayers = MAX_LAYER - MIN_LAYER + 1;
  const height = TOP_PADDING + (totalLayers - 1) * LAYER_GAP + BOTTOM_PADDING;

  return { positions, edges: renderedEdges, width: SVG_WIDTH, height, buckets };
}

function renderEdgeSvg(edge, positions, focusedLayer) {
  const s = positions[edge.source];
  const t = positions[edge.target];
  if (!s || !t) return "";
  const opacity = focusedLayer
    ? s.layer === focusedLayer || t.layer === focusedLayer
      ? 0.8
      : 0.18
    : 0.7;
  const strokeWidth = edge.kind === "prerequisite" ? 1.8 : 1.2;
  return `<line class="prime-silo-kg__edge"
    x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}"
    stroke="${pickEdgeColor(edge.kind)}"
    stroke-width="${strokeWidth}"
    stroke-opacity="${opacity}" />`;
}

function renderNodeSvg(positionEntry, props) {
  const { x, y, radius, layer, color, node } = positionEntry;
  const focused = props.focusedLayer;
  const inFocus = !focused || focused === layer;
  const opacity = inFocus ? 1 : 0.18;
  const selected = node.id === props.selectedNodeId;
  const label = node.display_name || node.canonical_name || node.id;
  const title =
    node.canonical_name && node.canonical_name !== label
      ? `${label} (${node.canonical_name})`
      : label;
  return `
    <g class="prime-silo-kg__node" data-node-id="${escapeHtml(node.id)}"${selected ? ' data-selected="true"' : ""} opacity="${opacity}">
      <title>${escapeHtml(title)}</title>
      <circle cx="${x}" cy="${y}" r="${radius}" fill="${color}" stroke="${selected ? "#f8fafc" : "rgba(15,23,42,0.85)"}" stroke-width="${selected ? 2.5 : 1.5}" />
      <text class="prime-silo-kg__node-label" x="${x}" y="${y + radius + 12}" text-anchor="middle">${escapeHtml(label)}</text>
    </g>
  `;
}

function renderLayerGuides(height) {
  const guides = [];
  for (let layer = MIN_LAYER; layer <= MAX_LAYER; layer += 1) {
    const y = TOP_PADDING + (layer - MIN_LAYER) * LAYER_GAP;
    guides.push(
      `<line class="prime-silo-kg__layer-guide" x1="0" y1="${y}" x2="${SVG_WIDTH}" y2="${y}" />`
    );
    guides.push(`<text class="prime-silo-kg__layer-label" x="6" y="${y - 6}">L${layer}</text>`);
  }
  return guides.join("");
}

export function renderSvg(layout, props) {
  const { positions, edges, width, height } = layout;
  const edgeSvg = edges.map((e) => renderEdgeSvg(e, positions, props.focusedLayer)).join("");
  const nodeSvg = Object.values(positions)
    .map((entry) => renderNodeSvg(entry, props))
    .join("");
  return `
    <svg class="prime-silo-kg__svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <g class="prime-silo-kg__layer-guides">${renderLayerGuides(height)}</g>
      <g class="prime-silo-kg__edges">${edgeSvg}</g>
      <g class="prime-silo-kg__nodes">${nodeSvg}</g>
    </svg>
  `;
}

function renderError(host, error) {
  const detail = (error && ((error.body && error.body.detail) || error.message)) || String(error);
  host.dataset.widgetState = STATE_ERROR;
  host.innerHTML = `<div class="prime-silo-kg__error">Knowledge graph load failed: ${escapeHtml(detail)}</div>`;
}

function renderLoading(host, props) {
  host.dataset.widgetState = STATE_LOADING;
  host.innerHTML = `<div class="prime-silo-kg__loading">Loading ontology for workspace ${escapeHtml(props.workspace || "default")}…</div>`;
}

function renderEmpty(host, props) {
  host.dataset.widgetState = STATE_READY;
  host.innerHTML = `<div class="prime-silo-kg__empty">No concepts in workspace <code>${escapeHtml(props.workspace || "default")}</code>. Ingest documents or run KG3D ontology compilation to populate the synoptic web.</div>`;
}

/**
 * Mount the synoptic-web widget into `host`.
 */
export function createSynopticWebWidget(host, initialProps, options = {}) {
  if (!host || typeof host.querySelector !== "function") {
    throw new Error("createSynopticWebWidget: host must be an HTMLElement.");
  }

  const client = ensureClient(options);
  const customRenderer = options && options.renderer ? options.renderer : null;
  let props = { ...initialProps };
  let aborted = false;
  let lastLayout = null;
  let rendererHandle = null;

  host.classList.add("prime-silo-kg");

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
        const response = await client.runtimeFetch(buildOntologyPath(props));
        payload = await client.readRuntimeJson(response);
      }
      if (aborted) return;
      const nodes = payload && Array.isArray(payload.nodes) ? payload.nodes : [];
      const edges = payload && Array.isArray(payload.edges) ? payload.edges : [];
      if (nodes.length === 0) {
        lastLayout = computeLayout([], []);
        renderEmpty(host, props);
        return;
      }
      lastLayout = computeLayout(nodes, edges);
      paint(lastLayout);
    } catch (err) {
      if (aborted) return;
      renderError(host, err);
    }
  }

  function update(nextProps) {
    const merged = { ...props, ...nextProps };
    const fetchKeyChanged =
      merged.workspace !== props.workspace || (merged.data || null) !== (props.data || null);
    props = merged;
    if (fetchKeyChanged) {
      load();
    } else if (lastLayout) {
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
      try {
        rendererHandle.dispose();
      } catch (_e) {
        /* swallow */
      }
    }
    rendererHandle = null;
    host.classList.remove("prime-silo-kg");
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
    }
  };
}

export const __testing = {
  buildOntologyPath,
  computeLayout,
  renderSvg,
  renderEdgeSvg,
  renderNodeSvg,
  pickCategoryColor,
  pickEdgeColor,
  clampLayer,
  CATEGORY_COLORS,
  EDGE_COLORS,
  MIN_LAYER,
  MAX_LAYER
};
