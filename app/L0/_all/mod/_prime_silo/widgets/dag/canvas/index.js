// ADR-001 Phase C — `dag.canvas` widget.
//
// Unified DAG renderer that collapses the upstream Studio canvases —
// ManifestCanvas (swarm waves), PipelineCanvas (Pypes stages),
// WorkflowCanvas (studio nodes) — into one parameterised widget. Mode
// controls colour palette and label semantics; layout is the same layered
// topological algorithm in all three.
//
// Authority: `deterministic_only`. The widget registry's
// `isAuthorityAgentSafe` already prevents agent-authored layouts from
// composing this widget; the factory adds a second line of defence by
// refusing to mount under `options.agentContext === true`. Two layers,
// same source of truth (the widget manifest's `authority` field).
//
// Public API
//   createDagCanvasWidget(host, props, options)
//     props   — {
//       mode: "manifest" | "pipeline" | "workflow",  // required
//       data: {
//         nodes: [{ id, label?, status?, stage?, kind?, wave?, group? }],
//         edges: [{ source, target } | [source, target]]
//       },                                            // required
//       selectedNodeId?: string,
//       onSelect?: (nodeId) => void
//     }
//     options — { agentContext?: boolean }
//
// Returns { update, refresh, destroy, get layout }.
//
// Implementation notes:
//   - Pure ES + DOM + SVG. No React, no ReactFlow, no build step.
//   - Layout: longest-path layering (a node's column is one greater than
//     the max column of its predecessors). Within a column, nodes are
//     stacked in input order.
//   - Edges are simple cubic-bezier paths between right-anchor of source
//     and left-anchor of target.
//   - Click handler delegated through the host element.

const STATE_READY = "ready";
const STATE_REJECTED = "rejected";
const STATE_ERROR = "error";

const SUPPORTED_MODES = new Set(["manifest", "pipeline", "workflow"]);

const NODE_W = 220;
const NODE_H = 84;
const COL_GAP = 100;
const ROW_GAP = 32;
const MARGIN = 24;

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

const STATUS_COLOR = {
  pending: "#64748b",
  running: "#3b82f6",
  completed: "#10b981",
  success: "#10b981",
  pass: "#10b981",
  warn: "#f59e0b",
  partial: "#f59e0b",
  failed: "#ef4444",
  fail: "#ef4444",
  error: "#ef4444",
  skipped: "#6b7280"
};

const STAGE_COLOR = {
  bronze: "#a16207",
  silver: "#94a3b8",
  gold: "#d97706",
  raw: "#475569",
  feature: "#7c3aed",
  governed: "#0891b2"
};

const KIND_COLOR = {
  trigger: "#4ade80",
  llm: "#a78bfa",
  tool: "#60a5fa",
  logic: "#fb923c",
  data: "#2dd4bf",
  a2a: "#0ea5e9",
  intervention: "#f59e0b"
};

function pickAccent(node, mode) {
  if (mode === "pipeline" && node.stage && STAGE_COLOR[node.stage]) {
    return STAGE_COLOR[node.stage];
  }
  if (mode === "workflow" && node.kind && KIND_COLOR[node.kind]) {
    return KIND_COLOR[node.kind];
  }
  if (node.status) {
    const key = String(node.status).toLowerCase();
    if (STATUS_COLOR[key]) {
      return STATUS_COLOR[key];
    }
  }
  return "#64748b";
}

function normaliseEdges(edges, nodeIds) {
  const out = [];
  for (const e of edges || []) {
    let source;
    let target;
    if (Array.isArray(e)) {
      source = e[0];
      target = e[1];
    } else if (e && typeof e === "object") {
      source = e.source;
      target = e.target;
    }
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
      continue;
    }
    out.push({ source, target });
  }
  return out;
}

/**
 * Layered topological layout. For each node, column = 1 + max(column of
 * predecessors). Cycles (self-loops or back-edges) collapse into the
 * earliest column they would otherwise create — we still place them
 * deterministically rather than throwing.
 *
 * Returns { columns: [[nodeId,...], ...], colOf: {nodeId: col} }.
 */
export function computeLayout(nodes, edges) {
  const nodeIds = new Set((nodes || []).map((n) => n.id));
  const cleanEdges = normaliseEdges(edges, nodeIds);
  const incoming = new Map();
  const outgoing = new Map();
  for (const id of nodeIds) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const { source, target } of cleanEdges) {
    if (source === target) {
      continue;
    }
    incoming.get(target).push(source);
    outgoing.get(source).push(target);
  }

  const colOf = {};
  // Iterative longest-path; visited nodes anchor the column they computed.
  function compute(id, stack) {
    if (colOf[id] !== undefined) {
      return colOf[id];
    }
    if (stack.has(id)) {
      // Cycle — stop here at column 0; deterministic and safe.
      return 0;
    }
    stack.add(id);
    let col = 0;
    for (const pred of incoming.get(id)) {
      col = Math.max(col, compute(pred, stack) + 1);
    }
    stack.delete(id);
    // For nodes that declare a `wave` explicitly (manifest mode), respect
    // it as a floor — keeps wave bands aligned even for nodes without
    // declared dependencies.
    const node = nodes.find((n) => n.id === id);
    if (node && typeof node.wave === "number" && node.wave >= 0) {
      col = Math.max(col, node.wave);
    }
    colOf[id] = col;
    return col;
  }
  for (const id of nodeIds) {
    compute(id, new Set());
  }

  const columns = [];
  // Preserve the original node order within each column.
  for (const node of nodes) {
    const c = colOf[node.id] || 0;
    while (columns.length <= c) columns.push([]);
    columns[c].push(node.id);
  }

  return { columns, colOf, edges: cleanEdges };
}

function nodePosition(col, row) {
  return {
    x: MARGIN + col * (NODE_W + COL_GAP),
    y: MARGIN + row * (NODE_H + ROW_GAP)
  };
}

function svgSizeFor(layout) {
  const cols = layout.columns.length;
  let maxRows = 0;
  for (const c of layout.columns) {
    if (c.length > maxRows) maxRows = c.length;
  }
  const width = MARGIN * 2 + cols * NODE_W + Math.max(0, cols - 1) * COL_GAP;
  const height = MARGIN * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP;
  return { width: Math.max(width, NODE_W + MARGIN * 2), height: Math.max(height, NODE_H + MARGIN * 2) };
}

export function renderEdgePath(srcPos, tgtPos) {
  const x1 = srcPos.x + NODE_W;
  const y1 = srcPos.y + NODE_H / 2;
  const x2 = tgtPos.x;
  const y2 = tgtPos.y + NODE_H / 2;
  const dx = Math.max(40, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function renderNode(node, pos, mode, selected) {
  const accent = pickAccent(node, mode);
  const label = node.label || node.id;
  const subline = mode === "manifest" && typeof node.wave === "number"
    ? `Wave ${node.wave}`
    : mode === "pipeline" && node.stage
      ? `Stage: ${node.stage}`
      : mode === "workflow" && node.kind
        ? node.kind
        : node.group || "";
  const status = node.status ? String(node.status) : "";
  const selectedAttr = selected ? ` data-selected="true"` : "";
  return `
    <g class="prime-silo-dag__node" data-node-id="${escapeHtml(node.id)}"${selectedAttr} transform="translate(${pos.x}, ${pos.y})">
      <rect class="prime-silo-dag__node-bg" width="${NODE_W}" height="${NODE_H}" rx="10" ry="10" stroke="${escapeHtml(accent)}"></rect>
      <text class="prime-silo-dag__node-id" x="12" y="20">${escapeHtml(node.id)}</text>
      <text class="prime-silo-dag__node-label" x="12" y="42">${escapeHtml(label)}</text>
      ${subline ? `<text class="prime-silo-dag__node-sub" x="12" y="62">${escapeHtml(subline)}</text>` : ""}
      ${status ? `<text class="prime-silo-dag__node-status" x="${NODE_W - 12}" y="20" text-anchor="end" fill="${escapeHtml(accent)}">${escapeHtml(status)}</text>` : ""}
    </g>
  `;
}

export function renderSvg(layout, props) {
  const { width, height } = svgSizeFor(layout);
  const positions = {};
  layout.columns.forEach((column, col) => {
    column.forEach((nodeId, row) => {
      positions[nodeId] = nodePosition(col, row);
    });
  });

  const nodesById = new Map((props.data.nodes || []).map((n) => [n.id, n]));

  const edgesSvg = layout.edges
    .map(({ source, target }) => {
      const s = positions[source];
      const t = positions[target];
      if (!s || !t) return "";
      return `<path class="prime-silo-dag__edge" d="${renderEdgePath(s, t)}" />`;
    })
    .join("");

  const nodesSvg = (props.data.nodes || [])
    .map((n) => {
      const pos = positions[n.id];
      if (!pos) return "";
      return renderNode(n, pos, props.mode, n.id === props.selectedNodeId);
    })
    .join("");

  return `
    <svg class="prime-silo-dag__svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <g class="prime-silo-dag__edges">${edgesSvg}</g>
      <g class="prime-silo-dag__nodes">${nodesSvg}</g>
    </svg>
  `;
}

function renderEmpty(host, mode) {
  host.dataset.widgetState = STATE_READY;
  host.innerHTML = `<div class="prime-silo-dag__empty">No ${escapeHtml(mode || "DAG")} nodes to display.</div>`;
}

function renderError(host, message) {
  host.dataset.widgetState = STATE_ERROR;
  host.innerHTML = `<div class="prime-silo-dag__error">DAG canvas error: ${escapeHtml(message)}</div>`;
}

function renderRejected(host) {
  host.dataset.widgetState = STATE_REJECTED;
  host.dataset.authorityRejected = "true";
  host.innerHTML = `<div class="prime-silo-dag__rejected">
    dag.canvas is <code>deterministic_only</code> — refusing to mount in agent context.
    Use this widget only from a static shell page.
  </div>`;
}

function isValidProps(props) {
  if (!props || !SUPPORTED_MODES.has(props.mode)) {
    return { ok: false, reason: `mode must be one of ${Array.from(SUPPORTED_MODES).join(", ")}` };
  }
  if (!props.data || !Array.isArray(props.data.nodes)) {
    return { ok: false, reason: "props.data.nodes must be an array" };
  }
  return { ok: true };
}

/**
 * Mount the dag.canvas widget into `host`.
 */
export function createDagCanvasWidget(host, initialProps, options = {}) {
  if (!host || typeof host.querySelector !== "function") {
    throw new Error("createDagCanvasWidget: host must be an HTMLElement.");
  }

  host.classList.add("prime-silo-dag");

  // Defence-in-depth: refuse to mount under agent context. The registry's
  // isAuthorityAgentSafe gate is the primary defence; this is the second.
  if (options && options.agentContext === true) {
    renderRejected(host);
    return {
      update: () => {},
      refresh: () => {},
      destroy: () => {
        host.classList.remove("prime-silo-dag");
        host.innerHTML = "";
        delete host.dataset.widgetState;
        delete host.dataset.authorityRejected;
      },
      get layout() { return null; }
    };
  }

  let props = { ...initialProps };
  let lastLayout = null;

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

  function render() {
    const validation = isValidProps(props);
    if (!validation.ok) {
      renderError(host, validation.reason);
      lastLayout = null;
      return;
    }
    const nodes = props.data.nodes;
    if (!nodes || nodes.length === 0) {
      lastLayout = { columns: [], colOf: {}, edges: [] };
      renderEmpty(host, props.mode);
      return;
    }
    lastLayout = computeLayout(nodes, props.data.edges || []);
    host.dataset.widgetState = STATE_READY;
    host.dataset.dagMode = props.mode;
    host.innerHTML = renderSvg(lastLayout, props);
  }

  function update(nextProps) {
    props = { ...props, ...nextProps };
    render();
  }

  function refresh() {
    render();
  }

  function destroy() {
    if (typeof host.removeEventListener === "function") {
      host.removeEventListener("click", onClick);
    }
    host.classList.remove("prime-silo-dag");
    host.innerHTML = "";
    delete host.dataset.widgetState;
    delete host.dataset.dagMode;
  }

  render();

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
  computeLayout,
  renderSvg,
  renderEdgePath,
  pickAccent,
  normaliseEdges,
  isValidProps,
  STATUS_COLOR,
  STAGE_COLOR,
  KIND_COLOR
};
