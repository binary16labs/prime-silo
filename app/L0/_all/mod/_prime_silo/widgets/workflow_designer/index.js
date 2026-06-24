// workflow_designer — interactive vanilla node editor (Phase 2 of the Prime-Silo
// workflow designer). This is the *editing* half of the Studio canvas: where
// `dag.canvas` renders a read-only DAG, this lets you drag nodes, add them from
// a palette, connect ports into edges, select, and delete — emitting the updated
// {nodes,edges} so the Bridge can save it.
//
// Deliberately pure ES + DOM + SVG — no React, no ReactFlow, no build step —
// matching the rest of the shell (see widgets/dag/canvas/index.js header).
//
// createWorkflowDesignerWidget(host, props)
//   props = {
//     workflow: { id, name, nodes:[{id,type,position:{x,y},data:{label,config}}],
//                 edges:[{id,source,target}] },
//     readonly?: boolean,                 // templates render but don't edit
//     onChange?: (graph) => void,         // {nodes,edges} after any edit
//     onSelect?: (node|null) => void      // selection changed
//   }
// Returns { update(workflow), getGraph(), select(id), destroy() }.

const NODE_W = 190;
const NODE_H = 64;
const PORT_R = 6;
const PAD = 60; // canvas margin around the node bounds

const KIND_COLOR = {
  trigger: "#4ade80",
  llm: "#a78bfa",
  tool: "#60a5fa",
  logic: "#fb923c",
  data: "#2dd4bf",
  a2a: "#0ea5e9"
};

// Palette mirrors Benny Studio's NodePalette categories.
const PALETTE = [
  { kind: "trigger", label: "Trigger" },
  { kind: "llm", label: "LLM / Agent" },
  { kind: "tool", label: "Tool" },
  { kind: "logic", label: "Logic" },
  { kind: "data", label: "Data" },
  { kind: "a2a", label: "A2A" }
];

const SVGNS = "http://www.w3.org/2000/svg";

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// Normalise an incoming workflow into editable node/edge arrays with positions.
function normalise(workflow) {
  const wf = workflow || {};
  const rawNodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const nodes = rawNodes.map((n, i) => {
    const pos =
      n.position && typeof n.position.x === "number"
        ? { x: n.position.x, y: n.position.y }
        : { x: PAD + (i % 4) * (NODE_W + 70), y: PAD + Math.floor(i / 4) * (NODE_H + 60) };
    return {
      id: n.id || uid("n"),
      type: n.type || "tool",
      position: pos,
      data: {
        label: (n.data && n.data.label) || n.label || n.id || "Node",
        config: (n.data && n.data.config) || {}
      }
    };
  });
  const edges = (Array.isArray(wf.edges) ? wf.edges : [])
    .filter((e) => e && e.source && e.target)
    .map((e) => ({ id: e.id || uid("e"), source: e.source, target: e.target }));
  return { nodes, edges };
}

export function createWorkflowDesignerWidget(host, props = {}) {
  if (!host || typeof host.appendChild !== "function") {
    throw new Error("createWorkflowDesignerWidget: host must be an HTMLElement.");
  }
  const readonly = !!props.readonly;
  const onChange = typeof props.onChange === "function" ? props.onChange : () => {};
  const onSelect = typeof props.onSelect === "function" ? props.onSelect : () => {};

  let { nodes, edges } = normalise(props.workflow);
  let selectedId = null;
  let drag = null; // { id, dx, dy }
  let connect = null; // { from, x, y }
  let raf = 0;

  host.classList.add("ps-wfd");
  host.innerHTML = "";

  // Toolbar (palette + delete). Hidden when readonly.
  const bar = document.createElement("div");
  bar.className = "ps-wfd__bar";
  if (!readonly) {
    bar.innerHTML =
      PALETTE.map(
        (p) =>
          `<button type="button" class="ps-wfd__add" data-add="${p.kind}" style="--k:${KIND_COLOR[p.kind]}">+ ${esc(p.label)}</button>`
      ).join("") +
      `<span class="ps-wfd__sep"></span><button type="button" class="ps-wfd__del" data-del>Delete selected</button>`;
  } else {
    bar.innerHTML = `<span class="ps-wfd__ro">Template — read-only. Clone it to edit.</span>`;
  }
  host.appendChild(bar);

  const scroll = document.createElement("div");
  scroll.className = "ps-wfd__scroll";
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "ps-wfd__svg");
  scroll.appendChild(svg);
  host.appendChild(scroll);

  function bounds() {
    let w = 480;
    let h = 280;
    for (const n of nodes) {
      w = Math.max(w, n.position.x + NODE_W + PAD);
      h = Math.max(h, n.position.y + NODE_H + PAD);
    }
    return { w, h };
  }

  function portPos(node, side) {
    return {
      x: node.position.x + (side === "out" ? NODE_W : 0),
      y: node.position.y + NODE_H / 2
    };
  }

  function edgePath(s, t) {
    const dx = Math.max(40, (t.x - s.x) / 2);
    return `M ${s.x} ${s.y} C ${s.x + dx} ${s.y}, ${t.x - dx} ${t.y}, ${t.x} ${t.y}`;
  }

  function draw() {
    const { w, h } = bounds();
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const edgeSvg = edges
      .map((e) => {
        const sN = byId.get(e.source);
        const tN = byId.get(e.target);
        if (!sN || !tN) return "";
        const d = edgePath(portPos(sN, "out"), portPos(tN, "in"));
        const sel = selectedId === e.id ? " is-selected" : "";
        return `<path class="ps-wfd__edge${sel}" data-edge-id="${esc(e.id)}" d="${d}" />`;
      })
      .join("");

    const tempSvg = connect
      ? `<path class="ps-wfd__edge ps-wfd__edge--temp" d="${edgePath(portPos(byId.get(connect.from), "out"), { x: connect.x, y: connect.y })}" />`
      : "";

    const nodeSvg = nodes
      .map((n) => {
        const accent = KIND_COLOR[n.type] || "#64748b";
        const sel = selectedId === n.id ? " is-selected" : "";
        return `
        <g class="ps-wfd__node${sel}" data-node-id="${esc(n.id)}" transform="translate(${n.position.x},${n.position.y})">
          <rect class="ps-wfd__node-bg" width="${NODE_W}" height="${NODE_H}" rx="9" ry="9" stroke="${esc(accent)}"></rect>
          <rect class="ps-wfd__node-kindbar" width="6" height="${NODE_H}" rx="3" fill="${esc(accent)}"></rect>
          <text class="ps-wfd__node-label" x="16" y="26">${esc(n.data.label)}</text>
          <text class="ps-wfd__node-kind" x="16" y="46" fill="${esc(accent)}">${esc(n.type)}</text>
          <circle class="ps-wfd__port ps-wfd__port--in" data-port="in" data-node-id="${esc(n.id)}" cx="0" cy="${NODE_H / 2}" r="${PORT_R}"></circle>
          <circle class="ps-wfd__port ps-wfd__port--out" data-port="out" data-node-id="${esc(n.id)}" cx="${NODE_W}" cy="${NODE_H / 2}" r="${PORT_R}"></circle>
        </g>`;
      })
      .join("");

    svg.innerHTML = `<g class="ps-wfd__edges">${edgeSvg}${tempSvg}</g><g class="ps-wfd__nodes">${nodeSvg}</g>`;
  }

  function emit() {
    onChange(getGraph());
  }
  function getGraph() {
    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: { ...n.position },
        data: { label: n.data.label, config: n.data.config || {} }
      })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target }))
    };
  }
  function setSelected(id) {
    selectedId = id;
    draw();
    const node = nodes.find((n) => n.id === id) || null;
    onSelect(node);
  }

  function localPoint(evt) {
    const r = svg.getBoundingClientRect();
    return { x: evt.clientX - r.left, y: evt.clientY - r.top };
  }

  function onPointerDown(evt) {
    if (readonly) return;
    const portEl = evt.target.closest && evt.target.closest("[data-port]");
    const nodeEl = evt.target.closest && evt.target.closest("[data-node-id]");
    const edgeEl = evt.target.closest && evt.target.closest("[data-edge-id]");
    if (portEl && portEl.getAttribute("data-port") === "out") {
      const p = localPoint(evt);
      connect = { from: portEl.getAttribute("data-node-id"), x: p.x, y: p.y };
      svg.setPointerCapture && svg.setPointerCapture(evt.pointerId);
      return;
    }
    if (nodeEl) {
      const id = nodeEl.getAttribute("data-node-id");
      const node = nodes.find((n) => n.id === id);
      const p = localPoint(evt);
      drag = { id, dx: p.x - node.position.x, dy: p.y - node.position.y };
      setSelected(id);
      svg.setPointerCapture && svg.setPointerCapture(evt.pointerId);
      return;
    }
    if (edgeEl) {
      setSelected(edgeEl.getAttribute("data-edge-id"));
      return;
    }
    setSelected(null);
  }

  function onPointerMove(evt) {
    if (!drag && !connect) return;
    const p = localPoint(evt);
    if (drag) {
      const node = nodes.find((n) => n.id === drag.id);
      if (node) {
        node.position.x = Math.max(0, p.x - drag.dx);
        node.position.y = Math.max(0, p.y - drag.dy);
      }
    } else if (connect) {
      connect.x = p.x;
      connect.y = p.y;
    }
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw();
      });
  }

  function onPointerUp(evt) {
    if (drag) {
      drag = null;
      emit();
      return;
    }
    if (connect) {
      const el = document.elementFromPoint(evt.clientX, evt.clientY);
      const targetEl = el && el.closest && el.closest("[data-node-id]");
      const to = targetEl && targetEl.getAttribute("data-node-id");
      if (
        to &&
        to !== connect.from &&
        !edges.some((e) => e.source === connect.from && e.target === to)
      ) {
        edges.push({ id: uid("e"), source: connect.from, target: to });
        emit();
      }
      connect = null;
      draw();
    }
  }

  function onBarClick(evt) {
    const add = evt.target.closest && evt.target.closest("[data-add]");
    if (add) {
      const kind = add.getAttribute("data-add");
      const n = {
        id: uid(kind),
        type: kind,
        position: { x: PAD + (nodes.length % 5) * 40, y: PAD + (nodes.length % 5) * 30 },
        data: { label: kind.charAt(0).toUpperCase() + kind.slice(1), config: {} }
      };
      nodes.push(n);
      setSelected(n.id);
      emit();
      return;
    }
    if (evt.target.closest && evt.target.closest("[data-del]")) deleteSelected();
  }

  function deleteSelected() {
    if (!selectedId) return;
    const beforeN = nodes.length,
      beforeE = edges.length;
    nodes = nodes.filter((n) => n.id !== selectedId);
    edges = edges.filter(
      (e) => e.id !== selectedId && e.source !== selectedId && e.target !== selectedId
    );
    if (nodes.length !== beforeN || edges.length !== beforeE) {
      selectedId = null;
      draw();
      onSelect(null);
      emit();
    }
  }

  function onKey(evt) {
    if (readonly) return;
    if (
      (evt.key === "Delete" || evt.key === "Backspace") &&
      selectedId &&
      document.activeElement === document.body
    ) {
      evt.preventDefault();
      deleteSelected();
    }
  }

  if (!readonly) {
    svg.addEventListener("pointerdown", onPointerDown);
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("pointerup", onPointerUp);
    bar.addEventListener("click", onBarClick);
    window.addEventListener("keydown", onKey);
  }

  draw();

  return {
    update(workflow) {
      const g = normalise(workflow);
      nodes = g.nodes;
      edges = g.edges;
      selectedId = null;
      draw();
    },
    getGraph,
    select(id) {
      setSelected(id);
    },
    // Update a single node's editable fields (label/type) from an external form.
    patchNode(id, patch) {
      const n = nodes.find((x) => x.id === id);
      if (!n) return;
      if (patch.label != null) n.data.label = patch.label;
      if (patch.type != null) n.type = patch.type;
      draw();
      emit();
    },
    destroy() {
      if (!readonly) {
        svg.removeEventListener("pointerdown", onPointerDown);
        svg.removeEventListener("pointermove", onPointerMove);
        svg.removeEventListener("pointerup", onPointerUp);
        bar.removeEventListener("click", onBarClick);
        window.removeEventListener("keydown", onKey);
      }
      if (raf) cancelAnimationFrame(raf);
      host.classList.remove("ps-wfd");
      host.innerHTML = "";
    }
  };
}
