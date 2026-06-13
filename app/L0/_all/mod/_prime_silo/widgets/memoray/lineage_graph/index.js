// Phase M1 — `memoray.lineage_graph` widget.
//
// Renders one session's lineage as a graph: Session → User Input → Thought →
// Tool Call → Tool Result → Artifact, plus tool-call→file reference links and
// virtual file nodes. Data comes from GET /api/memoray/graph/<sessionId>
// ({nodes, links}); the node/link shape is declared in the integration
// manifest (graph endpoint contract).
//
// Renderer pluggability (same seam as kg3d.synoptic_web / codegraph.canvas):
//   • The default renderer is a dependency-free 2D SVG depth-layered layout.
//     Entities flow left→right by BFS depth from the session root; Artifacts
//     (real + virtual files) render as rounded rectangles, everything else as
//     circles, coloured by Memo-Ray's organic palette.
//   • options.renderer = { mount, update, dispose } swaps in an alternative
//     (e.g. the lazy 3d-force-graph three_renderer) without the widget core
//     learning the renderer's library. The core computes the layout and hands
//     it to mount/update.
//
// Public API
//   createLineageGraphWidget(host, props, options)
//     props   — { sessionId: string, data?: {nodes, links}, onSelect?: (nodeId)=>void }
//     options — { memorayClient?, renderer? }
//   Returns { update, refresh, destroy, get layout }.

import {
  memorayFetch,
  readMemorayJson,
  isMemorayOffline,
  isMemorayDisabled
} from "../../../memoray_client/memoray-client.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Memo-Ray organic palette, by node type.
const NODE_TYPE_COLORS = {
  Session: "#c4a882",
  "User Input": "#c4a882",
  Thought: "#9caf88",
  Message: "#8a9aa4",
  "Tool Call": "#6b8068",
  "Tool Result": "#6b8068",
  Artifact: "#8a9aa4",
  default: "#6b7378"
};

const BAND_WIDTH = 150;
const BAND_GAP = 40;
const ROW_GAP = 26;
const NODE_RADIUS = 7;
const ARTIFACT_W = 90;
const ARTIFACT_H = 22;
const TOP_PADDING = 30;
const LEFT_PADDING = 24;
const SVG_MIN_HEIGHT = 260;

function ensureClient(options) {
  if (options && options.memorayClient) {
    return options.memorayClient;
  }
  return { memorayFetch, readMemorayJson };
}

function colorFor(type) {
  return NODE_TYPE_COLORS[type] || NODE_TYPE_COLORS.default;
}

function isArtifact(node) {
  return node && node.type === "Artifact";
}

function nodeLabel(node) {
  if (!node) return "(node)";
  return node.label || node.metadata?.fileName || node.type || node.id || "(node)";
}

/**
 * Compute a depth-layered layout from {nodes, links}.
 *
 * Depth is the BFS distance from the root (the session node, or the node
 * with no incoming link). Nodes at the same depth stack vertically. Returns
 * { positions: {id: {x,y,node,depth}}, edges: [{source,target}], width,
 * height }. Robust to cycles and orphan nodes (orphans land at depth 0).
 */
export function computeLayout(nodes, links) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const safeLinks = Array.isArray(links) ? links : [];
  const byId = new Map(safeNodes.map((n) => [n.id, n]));

  // Build adjacency + indegree.
  const children = new Map();
  const indegree = new Map();
  for (const n of safeNodes) indegree.set(n.id, 0);
  for (const link of safeLinks) {
    const source = typeof link.source === "object" ? link.source.id : link.source;
    const target = typeof link.target === "object" ? link.target.id : link.target;
    if (!byId.has(source) || !byId.has(target)) continue;
    if (!children.has(source)) children.set(source, []);
    children.get(source).push(target);
    indegree.set(target, (indegree.get(target) || 0) + 1);
  }

  // Roots = indegree 0 (sessions, orphans). BFS to assign depth.
  const depth = new Map();
  const queue = [];
  for (const n of safeNodes) {
    if ((indegree.get(n.id) || 0) === 0) {
      depth.set(n.id, 0);
      queue.push(n.id);
    }
  }
  // Fallback: if every node has an incoming link (pure cycle), seed first node.
  if (queue.length === 0 && safeNodes.length > 0) {
    depth.set(safeNodes[0].id, 0);
    queue.push(safeNodes[0].id);
  }
  const visited = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift();
    const d = depth.get(id) || 0;
    for (const childId of children.get(id) || []) {
      const candidate = d + 1;
      if (!depth.has(childId) || candidate > depth.get(childId)) {
        depth.set(childId, candidate);
      }
      if (!visited.has(childId)) {
        visited.add(childId);
        queue.push(childId);
      }
    }
  }

  // Any node never reached (disconnected) → depth 0.
  for (const n of safeNodes) {
    if (!depth.has(n.id)) depth.set(n.id, 0);
  }

  // Bucket by depth, stack.
  const bands = new Map();
  for (const n of safeNodes) {
    const d = depth.get(n.id);
    if (!bands.has(d)) bands.set(d, []);
    bands.get(d).push(n);
  }

  const positions = {};
  let maxRows = 0;
  for (const [d, bucket] of bands) {
    bucket.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    if (bucket.length > maxRows) maxRows = bucket.length;
    bucket.forEach((node, row) => {
      positions[node.id] = {
        x: LEFT_PADDING + d * (BAND_WIDTH + BAND_GAP),
        y: TOP_PADDING + row * ROW_GAP,
        depth: d,
        node
      };
    });
  }

  const edges = [];
  for (const link of safeLinks) {
    const source = typeof link.source === "object" ? link.source.id : link.source;
    const target = typeof link.target === "object" ? link.target.id : link.target;
    if (positions[source] && positions[target]) {
      edges.push({ source, target });
    }
  }

  const maxDepth = bands.size > 0 ? Math.max(...bands.keys()) : 0;
  const width = LEFT_PADDING * 2 + (maxDepth + 1) * (BAND_WIDTH + BAND_GAP);
  const height = Math.max(SVG_MIN_HEIGHT, TOP_PADDING * 2 + maxRows * ROW_GAP);

  return { positions, edges, width, height };
}

/* ── default 2D SVG renderer ─────────────────────────────────────────── */

function createDefaultRenderer() {
  let svg = null;
  let onSelect = null;

  function mount(hostEl, layout, props) {
    onSelect = props && props.onSelect;
    svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "mray-lg__svg");
    hostEl.appendChild(svg);
    update(layout, props);
    return { update, dispose };
  }

  function update(layout, props) {
    if (!svg) return;
    onSelect = (props && props.onSelect) || onSelect;
    const { positions, edges, width, height } = layout;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // edges first (under nodes)
    for (const edge of edges) {
      const a = positions[edge.source];
      const b = positions[edge.target];
      if (!a || !b) continue;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(a.x));
      line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x));
      line.setAttribute("y2", String(b.y));
      line.setAttribute("class", "mray-lg__edge");
      svg.appendChild(line);
    }

    // nodes
    for (const pos of Object.values(positions)) {
      const node = pos.node;
      const color = colorFor(node.type);
      const group = document.createElementNS(SVG_NS, "g");
      group.setAttribute("class", "mray-lg__node");
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.dataset.nodeId = node.id;
      group.setAttribute("aria-label", `${node.type}: ${nodeLabel(node)}`);

      if (isArtifact(node)) {
        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", String(pos.x - ARTIFACT_W / 2));
        rect.setAttribute("y", String(pos.y - ARTIFACT_H / 2));
        rect.setAttribute("width", String(ARTIFACT_W));
        rect.setAttribute("height", String(ARTIFACT_H));
        rect.setAttribute("rx", "5");
        rect.setAttribute("fill", color);
        rect.setAttribute("fill-opacity", node.metadata?.isVirtual ? "0.35" : "0.7");
        rect.setAttribute("stroke", color);
        group.appendChild(rect);
      } else {
        const circle = document.createElementNS(SVG_NS, "circle");
        circle.setAttribute("cx", String(pos.x));
        circle.setAttribute("cy", String(pos.y));
        circle.setAttribute("r", String(node.type === "Session" ? NODE_RADIUS + 4 : NODE_RADIUS));
        circle.setAttribute("fill", color);
        group.appendChild(circle);
      }

      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(pos.x + (isArtifact(node) ? 0 : NODE_RADIUS + 5)));
      text.setAttribute("y", String(pos.y + (isArtifact(node) ? 1 : 3)));
      text.setAttribute("class", "mray-lg__label");
      if (isArtifact(node)) text.setAttribute("text-anchor", "middle");
      const label = nodeLabel(node);
      text.textContent = label.length > 22 ? `${label.slice(0, 21)}…` : label;
      group.appendChild(text);

      const select = () => {
        if (typeof onSelect === "function") onSelect(node.id);
      };
      group.addEventListener("click", select);
      group.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          select();
        }
      });

      svg.appendChild(group);
    }
  }

  function dispose() {
    if (svg && svg.parentNode) svg.parentNode.removeChild(svg);
    svg = null;
    onSelect = null;
  }

  return { mount, update, dispose };
}

/* ── factory ─────────────────────────────────────────────────────────── */

export function createLineageGraphWidget(host, initialProps = {}, options = {}) {
  if (!host || typeof host.querySelector !== "function") {
    throw new Error("createLineageGraphWidget: host must be an HTMLElement.");
  }

  const client = ensureClient(options);
  const renderer = options.renderer || createDefaultRenderer();
  let props = { ...initialProps };
  let aborted = false;
  let rendererHandle = null;
  let layout = null;

  host.classList.add("mray-lg");

  function renderState(html) {
    teardownRenderer();
    host.innerHTML = `<div class="mray-lg__state">${html}</div>`;
  }

  function teardownRenderer() {
    if (rendererHandle && typeof rendererHandle.dispose === "function") {
      rendererHandle.dispose();
    } else if (typeof renderer.dispose === "function") {
      renderer.dispose();
    }
    rendererHandle = null;
  }

  function paint(data) {
    layout = computeLayout(data.nodes, data.links);
    host.innerHTML = "";
    if (rendererHandle && typeof rendererHandle.update === "function") {
      rendererHandle.update(layout, props);
    } else {
      rendererHandle = renderer.mount(host, layout, props);
    }
  }

  async function load() {
    if (props.data && Array.isArray(props.data.nodes)) {
      paint(props.data);
      return;
    }
    if (!props.sessionId) {
      renderState(`<p class="mray-lg__hint">Select a session to view its lineage.</p>`);
      return;
    }
    renderState(`<p class="mray-lg__loading">Loading lineage…</p>`);
    try {
      const data = await client.readMemorayJson(
        await client.memorayFetch(`/graph/${encodeURIComponent(props.sessionId)}`)
      );
      if (aborted) return;
      if (!data || !Array.isArray(data.nodes) || data.nodes.length === 0) {
        renderState(`<p class="mray-lg__hint">No lineage recorded for this session.</p>`);
        return;
      }
      paint(data);
    } catch (err) {
      if (aborted) return;
      if (isMemorayDisabled(err)) {
        renderState(`<p class="mray-lg__hint">Memo-Ray is disabled.</p>`);
      } else if (isMemorayOffline(err)) {
        renderState(`<p class="mray-lg__hint">Memo-Ray is offline — boot it with <code>scripts/memoray.ps1</code>.</p>`);
      } else {
        renderState(`<p class="mray-lg__error">Lineage load failed: ${escapeHtml(err.message)}</p>`);
      }
    }
  }

  function update(nextProps) {
    const merged = { ...props, ...nextProps };
    const changed = merged.sessionId !== props.sessionId || merged.data !== props.data;
    props = merged;
    if (changed) {
      teardownRenderer();
      load();
    }
  }

  function refresh() {
    teardownRenderer();
    return load();
  }

  function destroy() {
    aborted = true;
    teardownRenderer();
    host.classList.remove("mray-lg");
    host.innerHTML = "";
  }

  load();

  return {
    update,
    refresh,
    destroy,
    get layout() {
      return layout;
    }
  };
}

export const __testing = { computeLayout, colorFor, nodeLabel, createDefaultRenderer };
