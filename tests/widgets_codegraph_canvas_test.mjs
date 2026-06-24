#!/usr/bin/env node
//
// ADR-001 Phase C — codegraph.canvas widget tests.
//
// Eighth migrated widget; closes Phase C. Tests cover the runtime fetch
// path, banded layout (Folder→Concept), edge palette + dashed-edge
// rules, visibility filtering, snapshot/path query params, the inline-
// data fast path, the pluggable renderer hook, and lifecycle teardown.

import assert from "node:assert/strict";

import {
  createCodeGraphCanvasWidget,
  __testing as cgTesting
} from "../app/L0/_all/mod/_prime_silo/widgets/codegraph/canvas/index.js";

async function main() {
  testBuildCodeGraphPath();
  testNodeAndEdgeColorFallbacks();
  testBandIndexFor();
  testNodeLabelPriority();
  testComputeLayoutBandsAndOrdering();
  testComputeLayoutVisibilityFilter();
  testComputeLayoutDropsDanglingAndSelfEdges();
  testRenderSvgIncludesBandLabelsAndDashedEdges();
  await testWidgetLoadsViaFetch();
  await testWidgetSendsSnapshotAndPathParams();
  await testWidgetRendersFromInlineData();
  await testWidgetSurfacesError();
  await testWidgetEmptyGraph();
  await testWidgetUpdateReloadsOnSnapshotChange();
  await testWidgetUpdateRepaintsOnVisibilityChange();
  await testWidgetCustomRendererLifecycle();
  await testWidgetClickInvokesOnSelect();
  await testWidgetSelectedNodeIdHighlight();
  await testWidgetDestroyClearsHost();
  console.log("widgets_codegraph_canvas_test: ok");
}

function testBuildCodeGraphPath() {
  assert.equal(cgTesting.buildCodeGraphPath({}), "/graph/code?workspace=default");
  assert.equal(
    cgTesting.buildCodeGraphPath({
      workspace: "c5_test",
      snapshotId: "snap-1",
      pathFilter: "src/dangpy"
    }),
    "/graph/code?workspace=c5_test&snapshot_id=snap-1&path=src%2Fdangpy"
  );
}

function testNodeAndEdgeColorFallbacks() {
  assert.equal(cgTesting.pickNodeColor("File"), cgTesting.NODE_TYPE_COLORS.File);
  assert.equal(cgTesting.pickNodeColor("Function"), cgTesting.NODE_TYPE_COLORS.Function);
  assert.equal(cgTesting.pickNodeColor("Unknown"), cgTesting.NODE_TYPE_COLORS.default);
  assert.equal(cgTesting.pickNodeColor(undefined), cgTesting.NODE_TYPE_COLORS.default);

  assert.equal(cgTesting.pickEdgeColor("DEFINES"), cgTesting.EDGE_TYPE_COLORS.DEFINES);
  assert.equal(cgTesting.pickEdgeColor("INHERITS"), cgTesting.EDGE_TYPE_COLORS.INHERITS);
  assert.equal(cgTesting.pickEdgeColor("WEIRD"), cgTesting.EDGE_TYPE_COLORS.default);
}

function testBandIndexFor() {
  assert.equal(cgTesting.bandIndexFor("Folder"), 0);
  assert.equal(cgTesting.bandIndexFor("File"), 1);
  assert.equal(cgTesting.bandIndexFor("Concept"), 5);
  // Unknown types fall into the Module band as a deterministic default.
  assert.equal(cgTesting.bandIndexFor("Random"), cgTesting.TYPE_BAND_INDEX.Module);
}

function testNodeLabelPriority() {
  assert.equal(cgTesting.nodeLabel({ name: "n", path: "p", id: "i" }), "n");
  assert.equal(cgTesting.nodeLabel({ label: "l", path: "p", id: "i" }), "l");
  assert.equal(cgTesting.nodeLabel({ path: "src/foo.py", id: "i" }), "src/foo.py");
  assert.equal(cgTesting.nodeLabel({ id: "i" }), "i");
  assert.equal(cgTesting.nodeLabel({}), "(node)");
  assert.equal(cgTesting.nodeLabel(null), "(node)");
}

function testComputeLayoutBandsAndOrdering() {
  const nodes = [
    { id: "f1", type: "File", path: "src/b.py" },
    { id: "f0", type: "File", path: "src/a.py" },
    { id: "c1", type: "Class", name: "Bar", path: "src/a.py" },
    { id: "c0", type: "Class", name: "Foo", path: "src/a.py" },
    { id: "fn1", type: "Function", name: "bar", path: "src/a.py:Bar" },
    { id: "fn0", type: "Function", name: "foo", path: "src/a.py:Foo" }
  ];
  const layout = cgTesting.computeLayout(nodes, []);
  // Files band sorted by path: f0 (a.py) before f1 (b.py).
  const fileBand = layout.buckets[cgTesting.TYPE_BAND_INDEX.File];
  assert.equal(fileBand[0].id, "f0");
  assert.equal(fileBand[1].id, "f1");
  // File band x < Class band x < Function band x.
  assert.ok(layout.positions.f0.x < layout.positions.c0.x);
  assert.ok(layout.positions.c0.x < layout.positions.fn0.x);
  // Within a band, nodes share x.
  assert.equal(layout.positions.f0.x, layout.positions.f1.x);
  // Within a band, nodes are stacked vertically.
  assert.ok(layout.positions.f1.y > layout.positions.f0.y);
}

function testComputeLayoutVisibilityFilter() {
  const nodes = [
    { id: "f", type: "File", path: "x.py" },
    { id: "c", type: "Class", name: "C", path: "x.py" },
    { id: "fn", type: "Function", name: "fn", path: "x.py:C" }
  ];
  const layout = cgTesting.computeLayout(nodes, [], { visibleTypes: ["File", "Class"] });
  assert.ok(layout.positions.f);
  assert.ok(layout.positions.c);
  assert.equal(layout.positions.fn, undefined, "Function should be filtered out");
  // Only two bands rendered → empty bands collapse, so x positions are
  // adjacent (no Folder/Module/Function leading gap).
  const fileX = layout.positions.f.x;
  const classX = layout.positions.c.x;
  // Class should sit directly to the right of File with one band gap.
  assert.ok(classX > fileX);
}

function testComputeLayoutDropsDanglingAndSelfEdges() {
  const nodes = [
    { id: "a", type: "File", path: "a.py" },
    { id: "b", type: "Class", name: "B", path: "a.py" }
  ];
  const edges = [
    { source: "a", target: "b", type: "DEFINES" },
    { source: "a", target: "ghost", type: "DEFINES" }, // dropped
    { source: "ghost", target: "b", type: "DEFINES" }, // dropped
    { source: "a", target: "a", type: "DEFINES" } // self — dropped
  ];
  const layout = cgTesting.computeLayout(nodes, edges);
  assert.equal(layout.edges.length, 1);
  assert.equal(layout.edges[0].source, "a");
  assert.equal(layout.edges[0].target, "b");
  // Edge id falls back to source->target when missing.
  assert.equal(layout.edges[0].id, "a->b");
}

function testRenderSvgIncludesBandLabelsAndDashedEdges() {
  const layout = cgTesting.computeLayout(
    [
      { id: "f", type: "File", path: "x.py" },
      { id: "fn", type: "Function", name: "fn", path: "x.py" }
    ],
    [
      { source: "f", target: "fn", type: "DEFINES" },
      { source: "f", target: "fn", type: "CALLS", id: "edge-call" }
    ]
  );
  const svg = cgTesting.renderSvg(layout, {});
  assert.match(svg, /<svg /);
  assert.match(svg, />File</);
  assert.match(svg, />Function</);
  // CALLS edge should be dashed; DEFINES should not.
  assert.match(svg, /data-edge-type="CALLS"[^/]*stroke-dasharray="4 3"/);
  assert.doesNotMatch(svg, /data-edge-type="DEFINES"[^/]*stroke-dasharray/);
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
    this.parent = null;
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
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
      const list = this._listeners.get(type) || [];
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function makeRuntimeError(status, detail) {
  const err = new Error(detail);
  err.name = "RuntimeError";
  err.status = status;
  err.body = { detail };
  return err;
}

function createClientStub() {
  const calls = [];
  const stub = {
    calls,
    runtimeHandler: null,
    runtimeFetch: null,
    readRuntimeJson: async (response) => {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
  };
  stub.runtimeFetch = async (path, init = {}) => {
    calls.push({ path, init });
    if (!stub.runtimeHandler) {
      throw new Error("no runtimeHandler installed for path " + path);
    }
    const result = stub.runtimeHandler(path, init);
    if (result instanceof Error) throw result;
    return result;
  };
  return stub;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

const SAMPLE_GRAPH = {
  nodes: [
    { id: "file-a", type: "File", path: "src/a.py", name: "a.py" },
    { id: "class-A", type: "Class", path: "src/a.py", name: "A" },
    { id: "fn-foo", type: "Function", path: "src/a.py:A", name: "foo" }
  ],
  edges: [
    { source: "file-a", target: "class-A", type: "DEFINES" },
    { source: "class-A", target: "fn-foo", type: "DEFINES" },
    { source: "fn-foo", target: "fn-foo", type: "CALLS" } // self — dropped
  ]
};

async function testWidgetLoadsViaFetch() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = (path) => {
    assert.match(path, /\/graph\/code\?workspace=c5_test/);
    return jsonResponse(SAMPLE_GRAPH);
  };

  const handle = createCodeGraphCanvasWidget(
    host,
    { workspace: "c5_test" },
    { runtimeClient: client }
  );
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /a\.py/);
  assert.match(host.innerHTML, /foo/);
  assert.equal(client.calls.length, 1);
  assert.ok(handle.layout);
  assert.ok(handle.rawGraph);
  assert.equal(handle.rawGraph.nodes.length, 3);
}

async function testWidgetSendsSnapshotAndPathParams() {
  const host = createFakeHost();
  const client = createClientStub();
  let observedPath = null;
  client.runtimeHandler = (path) => {
    observedPath = path;
    return jsonResponse({ nodes: [], edges: [] });
  };

  createCodeGraphCanvasWidget(
    host,
    { workspace: "c5_test", snapshotId: "snap-9", pathFilter: "src/dangpy" },
    { runtimeClient: client }
  );
  await settle();

  assert.match(observedPath, /snapshot_id=snap-9/);
  assert.match(observedPath, /path=src%2Fdangpy/);
}

async function testWidgetRendersFromInlineData() {
  const host = createFakeHost();
  const client = createClientStub();
  // No runtimeHandler — fetch would throw if called.
  createCodeGraphCanvasWidget(host, { data: SAMPLE_GRAPH }, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /class-A|A/);
  assert.equal(client.calls.length, 0);
}

async function testWidgetSurfacesError() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => makeRuntimeError(500, "neo4j connection refused");

  createCodeGraphCanvasWidget(host, {}, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "error");
  assert.match(host.innerHTML, /neo4j connection refused/);
}

async function testWidgetEmptyGraph() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse({ nodes: [], edges: [] });

  createCodeGraphCanvasWidget(host, { workspace: "fresh" }, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /No code-graph nodes/);
  assert.match(host.innerHTML, /<code>fresh<\/code>/);
}

async function testWidgetUpdateReloadsOnSnapshotChange() {
  const host = createFakeHost();
  const client = createClientStub();
  let nthLoad = 0;
  client.runtimeHandler = (path) => {
    nthLoad += 1;
    return jsonResponse({
      nodes: [{ id: `n-${nthLoad}`, type: "File", name: `f${nthLoad}.py`, path: `f${nthLoad}.py` }],
      edges: []
    });
  };

  const widget = createCodeGraphCanvasWidget(
    host,
    { workspace: "c5_test" },
    { runtimeClient: client }
  );
  await settle();
  assert.equal(client.calls.length, 1);

  widget.update({ snapshotId: "snap-X" });
  await settle();
  assert.equal(client.calls.length, 2);
  assert.match(host.innerHTML, /f2\.py/);
}

async function testWidgetUpdateRepaintsOnVisibilityChange() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse(SAMPLE_GRAPH);

  const widget = createCodeGraphCanvasWidget(
    host,
    { workspace: "c5_test" },
    { runtimeClient: client }
  );
  await settle();
  assert.match(host.innerHTML, /foo/);

  widget.update({ visibleTypes: ["File", "Class"] });
  await settle();

  // No new fetch — visibility is a render-only change.
  assert.equal(client.calls.length, 1);
  // Function `foo` should be filtered out of the rendered SVG.
  assert.doesNotMatch(host.innerHTML, /data-node-id="fn-foo"/);
  assert.match(host.innerHTML, /data-node-id="file-a"/);
}

async function testWidgetCustomRendererLifecycle() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse(SAMPLE_GRAPH);

  const renderCalls = [];
  let disposeCalled = 0;
  const customRenderer = {
    mount(_h, layout, props) {
      renderCalls.push({
        phase: "mount",
        nodeCount: Object.keys(layout.positions).length,
        props: { ...props }
      });
      return {
        update(nextLayout, nextProps) {
          renderCalls.push({
            phase: "update",
            nodeCount: Object.keys(nextLayout.positions).length,
            props: { ...nextProps }
          });
        },
        dispose() {
          disposeCalled += 1;
        }
      };
    }
  };

  const widget = createCodeGraphCanvasWidget(
    host,
    { workspace: "c5_test" },
    { runtimeClient: client, renderer: customRenderer }
  );
  await settle();
  assert.equal(renderCalls.length, 1);
  assert.equal(renderCalls[0].phase, "mount");
  assert.doesNotMatch(host.innerHTML, /<svg /);

  widget.update({ visibleTypes: ["File"] });
  await settle();
  assert.equal(renderCalls.length, 2);
  assert.equal(renderCalls[1].phase, "update");
  // Only File visible → 1 node in layout.
  assert.equal(renderCalls[1].nodeCount, 1);

  widget.destroy();
  assert.equal(disposeCalled, 1);
}

async function testWidgetClickInvokesOnSelect() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse(SAMPLE_GRAPH);

  const clicks = [];
  createCodeGraphCanvasWidget(
    host,
    { onSelect: (id) => clicks.push(id) },
    { runtimeClient: client }
  );
  await settle();

  const nodeEl = new FakeElement("g", { "data-node-id": "class-A" });
  const inner = new FakeElement("circle");
  inner.parent = nodeEl;
  host.dispatch("click", { target: inner });

  assert.deepEqual(clicks, ["class-A"]);
}

async function testWidgetSelectedNodeIdHighlight() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse(SAMPLE_GRAPH);

  createCodeGraphCanvasWidget(host, { selectedNodeId: "class-A" }, { runtimeClient: client });
  await settle();

  assert.match(host.innerHTML, /data-node-id="class-A"[^>]*data-selected="true"/);
  assert.doesNotMatch(host.innerHTML, /data-node-id="file-a"[^>]*data-selected="true"/);
}

async function testWidgetDestroyClearsHost() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse(SAMPLE_GRAPH);

  const handle = createCodeGraphCanvasWidget(host, {}, { runtimeClient: client });
  await settle();
  assert.match(host.innerHTML, /<svg /);
  handle.destroy();
  assert.equal(host.innerHTML, "");
  assert.equal(host.dataset.widgetState, undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
