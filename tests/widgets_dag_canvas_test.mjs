#!/usr/bin/env node
//
// ADR-001 Phase C — dag.canvas widget tests.
//
// Sixth migrated widget; first `deterministic_only` widget. Tests cover
// the layout algorithm, mode-driven colour palette, authority rejection
// under agent context, click delegation, and the three render modes
// (manifest/pipeline/workflow).

import assert from "node:assert/strict";

import {
  createDagCanvasWidget,
  __testing as dcTesting
} from "../app/L0/_all/mod/_prime_silo/widgets/dag/canvas/index.js";

async function main() {
  testIsValidProps();
  testNormaliseEdges();
  testComputeLayoutLongestPath();
  testComputeLayoutWaveFloor();
  testComputeLayoutTolerantOfCycles();
  testPickAccentByMode();
  testRenderEdgePathShape();
  testRenderSvgIncludesAllNodes();
  testWidgetRejectsAgentContext();
  testWidgetRefusesInvalidProps();
  testWidgetEmptyState();
  testWidgetRendersAndExposesLayout();
  testWidgetUpdateReRenders();
  testWidgetClickInvokesOnSelect();
  testWidgetSelectedNodeIdHighlight();
  testWidgetDestroyClearsHost();
  console.log("widgets_dag_canvas_test: ok");
}

function testIsValidProps() {
  assert.equal(dcTesting.isValidProps(null).ok, false);
  assert.equal(dcTesting.isValidProps({}).ok, false);
  assert.equal(dcTesting.isValidProps({ mode: "weird" }).ok, false);
  assert.equal(dcTesting.isValidProps({ mode: "manifest" }).ok, false, "data is required");
  assert.equal(dcTesting.isValidProps({ mode: "manifest", data: { nodes: [] } }).ok, true);
}

function testNormaliseEdges() {
  const ids = new Set(["a", "b", "c"]);
  const edges = [
    { source: "a", target: "b" },
    ["b", "c"],
    { source: "a", target: "ghost" }, // dropped — unknown target
    { source: "ghost", target: "a" }, // dropped
    "junk" // dropped
  ];
  const out = dcTesting.normaliseEdges(edges, ids);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { source: "a", target: "b" });
  assert.deepEqual(out[1], { source: "b", target: "c" });
}

function testComputeLayoutLongestPath() {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  // Diamond: a → b, a → c, b → d, c → d.
  const edges = [
    ["a", "b"],
    ["a", "c"],
    ["b", "d"],
    ["c", "d"]
  ];
  const layout = dcTesting.computeLayout(nodes, edges);
  assert.equal(layout.colOf.a, 0);
  assert.equal(layout.colOf.b, 1);
  assert.equal(layout.colOf.c, 1);
  assert.equal(layout.colOf.d, 2);
  // d should be the only node in column 2.
  assert.deepEqual(layout.columns[2], ["d"]);
}

function testComputeLayoutWaveFloor() {
  // Node x has no predecessors but declares wave: 3 — column should be 3.
  const nodes = [{ id: "a" }, { id: "x", wave: 3 }];
  const layout = dcTesting.computeLayout(nodes, []);
  assert.equal(layout.colOf.a, 0);
  assert.equal(layout.colOf.x, 3);
  assert.equal(layout.columns.length, 4);
}

function testComputeLayoutTolerantOfCycles() {
  // a → b → a creates a cycle. Layout shouldn't throw — should pin
  // cycle members to column 0.
  const nodes = [{ id: "a" }, { id: "b" }];
  const edges = [
    ["a", "b"],
    ["b", "a"]
  ];
  const layout = dcTesting.computeLayout(nodes, edges);
  assert.ok(typeof layout.colOf.a === "number");
  assert.ok(typeof layout.colOf.b === "number");
}

function testPickAccentByMode() {
  // Pipeline mode → stage colour wins over status.
  assert.equal(
    dcTesting.pickAccent({ stage: "gold", status: "completed" }, "pipeline"),
    dcTesting.STAGE_COLOR.gold
  );
  // Workflow mode → kind colour wins.
  assert.equal(
    dcTesting.pickAccent({ kind: "llm", status: "completed" }, "workflow"),
    dcTesting.KIND_COLOR.llm
  );
  // Manifest mode → status colour.
  assert.equal(
    dcTesting.pickAccent({ status: "completed" }, "manifest"),
    dcTesting.STATUS_COLOR.completed
  );
  // Unknown status falls back to neutral.
  const accent = dcTesting.pickAccent({ status: "weird" }, "manifest");
  assert.equal(typeof accent, "string");
  assert.match(accent, /^#/);
}

function testRenderEdgePathShape() {
  const path = dcTesting.renderEdgePath({ x: 0, y: 0 }, { x: 400, y: 100 });
  // Should be a valid cubic Bézier.
  assert.match(path, /^M\s+\d/);
  assert.match(path, /\sC\s/);
}

function testRenderSvgIncludesAllNodes() {
  const layout = dcTesting.computeLayout(
    [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" }
    ],
    [["a", "b"]]
  );
  const svg = dcTesting.renderSvg(layout, {
    mode: "manifest",
    data: {
      nodes: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" }
      ],
      edges: [["a", "b"]]
    }
  });
  assert.match(svg, /<svg /);
  assert.match(svg, /data-node-id="a"/);
  assert.match(svg, /data-node-id="b"/);
  assert.match(svg, /Alpha/);
  assert.match(svg, /Beta/);
  // One edge path expected.
  const pathMatches = svg.match(/class="prime-silo-dag__edge"/g) || [];
  assert.equal(pathMatches.length, 1);
}

class FakeClassList {
  constructor() {
    this._set = new Set();
  }
  add(...n) {
    n.forEach((x) => this._set.add(x));
  }
  remove(...n) {
    n.forEach((x) => this._set.delete(x));
  }
  has(name) {
    return this._set.has(name);
  }
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this._handlers = new Map();
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  closest(selector) {
    if (!selector.startsWith("[") || !selector.endsWith("]")) return null;
    const attr = selector.slice(1, -1);
    let node = this;
    while (node) {
      if (node.attrs && Object.prototype.hasOwnProperty.call(node.attrs, attr)) {
        return node;
      }
      node = node.parent;
    }
    return null;
  }
}

function createFakeHost() {
  const host = {
    classList: new FakeClassList(),
    dataset: {},
    innerHTML: "",
    _listeners: new Map(),
    addEventListener(type, handler) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this._listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    },
    dispatch(type, event) {
      const list = this._listeners.get(type) || [];
      for (const h of list) h(event);
    },
    querySelector: () => null
  };
  return host;
}

function testWidgetRejectsAgentContext() {
  const host = createFakeHost();
  const handle = createDagCanvasWidget(
    host,
    { mode: "manifest", data: { nodes: [{ id: "a" }] } },
    { agentContext: true }
  );
  assert.equal(host.dataset.widgetState, "rejected");
  assert.equal(host.dataset.authorityRejected, "true");
  assert.match(host.innerHTML, /deterministic_only/);
  assert.match(host.innerHTML, /refusing to mount/);
  // Update / refresh must be safe no-ops; destroy should clean up.
  handle.update({ mode: "pipeline" });
  handle.refresh();
  assert.equal(host.dataset.authorityRejected, "true");
  handle.destroy();
  assert.equal(host.dataset.authorityRejected, undefined);
  assert.equal(host.innerHTML, "");
}

function testWidgetRefusesInvalidProps() {
  const host = createFakeHost();
  createDagCanvasWidget(host, { mode: "weird", data: { nodes: [] } });
  assert.equal(host.dataset.widgetState, "error");
  assert.match(host.innerHTML, /mode must be one of/);
}

function testWidgetEmptyState() {
  const host = createFakeHost();
  createDagCanvasWidget(host, { mode: "pipeline", data: { nodes: [] } });
  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /No pipeline nodes to display/);
}

function testWidgetRendersAndExposesLayout() {
  const host = createFakeHost();
  const handle = createDagCanvasWidget(host, {
    mode: "pipeline",
    data: {
      nodes: [
        { id: "ingest", stage: "bronze", status: "completed", label: "Ingest" },
        { id: "exposure", stage: "gold", status: "running" }
      ],
      edges: [{ source: "ingest", target: "exposure" }]
    }
  });
  assert.equal(host.dataset.widgetState, "ready");
  assert.equal(host.dataset.dagMode, "pipeline");
  assert.match(host.innerHTML, /Stage: bronze/);
  assert.match(host.innerHTML, /Stage: gold/);
  // Status text rendered in pipeline mode.
  assert.match(host.innerHTML, /completed/);
  // Layout exposed via getter.
  assert.equal(handle.layout.colOf.ingest, 0);
  assert.equal(handle.layout.colOf.exposure, 1);
}

function testWidgetUpdateReRenders() {
  const host = createFakeHost();
  const handle = createDagCanvasWidget(host, {
    mode: "manifest",
    data: { nodes: [{ id: "a", label: "Alpha" }], edges: [] }
  });
  assert.match(host.innerHTML, /Alpha/);
  handle.update({
    data: { nodes: [{ id: "b", label: "Beta" }], edges: [] }
  });
  assert.match(host.innerHTML, /Beta/);
  assert.doesNotMatch(host.innerHTML, /Alpha/);
}

function testWidgetClickInvokesOnSelect() {
  const host = createFakeHost();
  const clicks = [];
  createDagCanvasWidget(host, {
    mode: "manifest",
    data: { nodes: [{ id: "x" }], edges: [] },
    onSelect: (id) => clicks.push(id)
  });
  // Simulate a click on a node target; closest() walks the parent chain
  // and matches the [data-node-id] attribute.
  const nodeEl = new FakeElement("g", { "data-node-id": "x" });
  const inner = new FakeElement("rect");
  inner.parent = nodeEl;
  host.dispatch("click", { target: inner });
  assert.deepEqual(clicks, ["x"]);

  // Click outside any node should not fire.
  host.dispatch("click", { target: new FakeElement("div") });
  assert.deepEqual(clicks, ["x"]);
}

function testWidgetSelectedNodeIdHighlight() {
  const host = createFakeHost();
  createDagCanvasWidget(host, {
    mode: "manifest",
    data: { nodes: [{ id: "a" }, { id: "b" }], edges: [] },
    selectedNodeId: "b"
  });
  assert.match(host.innerHTML, /data-node-id="b"\s+data-selected="true"/);
  assert.doesNotMatch(host.innerHTML, /data-node-id="a"\s+data-selected="true"/);
}

function testWidgetDestroyClearsHost() {
  const host = createFakeHost();
  const handle = createDagCanvasWidget(host, {
    mode: "manifest",
    data: { nodes: [{ id: "a" }], edges: [] }
  });
  assert.match(host.innerHTML, /data-node-id="a"/);
  handle.destroy();
  assert.equal(host.innerHTML, "");
  assert.equal(host.dataset.widgetState, undefined);
  assert.equal(host.dataset.dagMode, undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
