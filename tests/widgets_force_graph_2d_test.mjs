#!/usr/bin/env node
//
// Organic 2D force-graph drop-in renderer.
//
// Renders into a fake DOM host (the renderer only reaches host.innerHTML,
// host.querySelector existence, and — guarded — host.ownerDocument /
// host.appendChild / host.getBoundingClientRect). The `force-graph` lib is
// stubbed via `options.loader` so this node-runner test never imports the
// vendored bundle or touches the DOM. Minimap creation is skipped (the fake
// host has no ownerDocument), so no canvas/2d-context is needed.

import assert from "node:assert/strict";

import {
  createForceGraph2DRenderer,
  layoutToGraphData,
  nodeMatchesProps,
  __testing
} from "../app/L0/_all/mod/_prime_silo/widgets/force_graph_2d/index.js";

async function main() {
  // Pure normalisers — no DOM, no async.
  testLayoutToGraphDataEmpty();
  testLayoutLineageShapeDerivesColorFromType();
  testLayoutKg3dShapeKeepsColorAndLayer();
  testLayoutFluidSeedsXYPinnedFixesFxFy();
  testLayoutDropsEdgesWithMissingEnds();
  testColorForFallback();
  testLabelForAcrossWidgetShapes();
  testIdentifierForFullPath();
  testHighlightIdsFromProps();
  testNodeMatchesProps();

  // Factory + mount lifecycle.
  testFactoryReturnsMountShape();
  testFactoryIsLazyAndDoesNotCallLoader();
  await testMountReturnsSyncHandle();
  await testMountCallsLoaderAndAppliesData();
  await testUpdateAfterLoadAppliesData();
  await testUpdateBeforeLoadIsReplayedOnActivation();
  await testDisposeBeforeLoadCancelsActivation();
  await testDisposeAfterLoadCallsDestructor();
  await testLoaderErrorPaintsInlineError();
  await testLoaderReturnsNonFunctionPaintsInlineError();
  await testOnSelectWiresThroughOnClick();
  await testFactoryClickFiresWhenNoOnSelect();
  await testLayerFilterDropsHiddenNodes();
  testMountRejectsBadHost();

  console.log("widgets_force_graph_2d_test: ok");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeHost() {
  return {
    innerHTML: "",
    classList: { add() {}, remove() {} },
    querySelector() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {}
  };
}

function stubForceGraph() {
  // Mirrors force-graph's curried/fluent API. Records every call and the
  // handlers it was given so tests can drive clicks and assert the wire shape.
  const instance = {
    _calls: [],
    _handlers: {},
    _data: null,
    _destroyed: false
  };
  const fluent = (name) =>
    function (...args) {
      this._calls.push([name, args]);
      if (typeof args[0] === "function") this._handlers[name] = args[0];
      return this;
    };
  for (const m of [
    "backgroundColor",
    "nodeRelSize",
    "nodeLabel",
    "nodeCanvasObject",
    "nodePointerAreaPaint",
    "linkColor",
    "linkWidth",
    "linkDirectionalParticles",
    "linkDirectionalParticleWidth",
    "linkDirectionalParticleSpeed",
    "d3VelocityDecay",
    "warmupTicks",
    "cooldownTime",
    "onNodeClick",
    "onNodeHover",
    "onBackgroundClick",
    "onEngineStop",
    "zoomToFit"
  ]) {
    instance[m] = fluent(m);
  }
  instance.graphData = function (...args) {
    if (args.length) {
      this._data = args[0];
      this._calls.push(["graphData", args]);
      return this;
    }
    return this._data;
  };
  instance._destructor = function () {
    this._destroyed = true;
  };
  const ForceGraph = () => (host) => {
    instance._host = host;
    return instance;
  };
  ForceGraph._instance = instance;
  return ForceGraph;
}

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function delayedLoader(ForceGraph) {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return {
    loader: () => promise,
    flush() {
      resolve(ForceGraph);
      return promise;
    }
  };
}

function lineageLayout() {
  // Shape produced by memoray.lineage_graph — no color/radius, type lives on
  // positions[id].node.type.
  return {
    positions: {
      s1: { x: 24, y: 30, depth: 0, node: { id: "s1", type: "Session", content: "My session" } },
      t1: { x: 214, y: 30, depth: 1, node: { id: "t1", type: "Thought", label: "thinking" } },
      a1: { x: 404, y: 30, depth: 2, node: { id: "a1", type: "Artifact", label: "out.json" } }
    },
    edges: [
      { source: "s1", target: "t1" },
      { source: "t1", target: "a1" }
    ],
    width: 600,
    height: 260
  };
}

function kg3dLayout() {
  return {
    positions: {
      neural_nets: {
        x: 100,
        y: 50,
        radius: 12,
        layer: 1,
        color: "#a78bfa",
        node: { id: "neural_nets" }
      },
      backprop: { x: 200, y: 140, radius: 8, layer: 3, color: "#22d3ee", node: { id: "backprop" } }
    },
    edges: [
      { id: "e1", source: "neural_nets", target: "backprop", kind: "prerequisite", weight: 0.9 }
    ],
    width: 720,
    height: 480
  };
}

// ---------------------------------------------------------------------------
// layoutToGraphData
// ---------------------------------------------------------------------------

function testLayoutToGraphDataEmpty() {
  const out = layoutToGraphData(null);
  assert.deepEqual(out, { nodes: [], links: [] });
  const out2 = layoutToGraphData({});
  assert.deepEqual(out2, { nodes: [], links: [] });
}

function testLayoutLineageShapeDerivesColorFromType() {
  const { nodes, links } = layoutToGraphData(lineageLayout(), "fluid");
  assert.equal(nodes.length, 3);
  const session = nodes.find((n) => n.id === "s1");
  // Session → golden from the Memo-Ray palette (no explicit color in layout).
  assert.equal(session.color, __testing.PALETTE.Session);
  assert.equal(session.type, "Session");
  // label prefers node.content / node.label.
  assert.equal(session.label, "My session");
  // No radius in lineage layout → default node val.
  assert.equal(typeof nodes[0].val, "number");
  assert.equal(links.length, 2);
}

function testLayoutKg3dShapeKeepsColorAndLayer() {
  const { nodes } = layoutToGraphData(kg3dLayout(), "fluid");
  const nn = nodes.find((n) => n.id === "neural_nets");
  assert.equal(nn.color, "#a78bfa"); // explicit color preserved
  assert.equal(nn.val, 12); // radius → val
  assert.equal(nn.layer, 1);
}

function testLayoutFluidSeedsXYPinnedFixesFxFy() {
  const fluid = layoutToGraphData(kg3dLayout(), "fluid").nodes[0];
  assert.equal(fluid.x, 100);
  assert.equal(fluid.y, 50);
  assert.equal(fluid.fx, undefined);
  assert.equal(fluid.fy, undefined);

  const pinned = layoutToGraphData(kg3dLayout(), "pinned").nodes[0];
  assert.equal(pinned.fx, 100);
  assert.equal(pinned.fy, 50);
  assert.equal(pinned.x, undefined);
}

function testLayoutDropsEdgesWithMissingEnds() {
  const layout = {
    positions: { a: { x: 0, y: 0 } },
    edges: [
      { source: "a", target: "b" },
      { source: null, target: "a" },
      { source: "a", target: "a" }
    ]
  };
  const { links } = layoutToGraphData(layout);
  // Only the two edges with both ends non-null survive normalisation.
  assert.equal(links.length, 2);
  for (const l of links) {
    assert.equal(typeof l.source, "string");
    assert.equal(typeof l.target, "string");
  }
}

function testColorForFallback() {
  assert.equal(__testing.colorFor({ color: "#abc123" }), "#abc123");
  assert.equal(__testing.colorFor({ type: "Tool Call" }), __testing.PALETTE["Tool Call"]);
  assert.equal(__testing.colorFor({ node: { type: "Error" } }), __testing.PALETTE.Error);
  assert.equal(__testing.colorFor({}), __testing.DEFAULT_NODE_COLOR);
}

function testLabelForAcrossWidgetShapes() {
  const { labelFor, basename } = __testing;
  // kg3d (Documents): display_name wins, then canonical_name.
  assert.equal(
    labelFor({ node: { display_name: "Neural Networks", canonical_name: "nn" } }),
    "Neural Networks"
  );
  assert.equal(labelFor({ node: { canonical_name: "Backpropagation" } }), "Backpropagation");
  // codegraph (Code): name wins; a bare path is shortened to its basename.
  assert.equal(labelFor({ node: { name: "authenticate" } }), "authenticate");
  assert.equal(labelFor({ node: { type: "File", path: "/src/app/services/auth.py" } }), "auth.py");
  // memoray (Memory): content.
  assert.equal(labelFor({ node: { type: "Session", content: "My session" } }), "My session");
  // No name anywhere, id is a path → basename, not the raw path or bare type.
  assert.equal(labelFor({ id: "/repo/pkg/mod.py", node: { type: "File" } }), "mod.py");
  // Truly nothing → falls back to type, never empty.
  assert.equal(labelFor({ node: { type: "Concept" } }), "Concept");
  assert.equal(basename("C:\\a\\b\\thing.txt"), "thing.txt");
}

function testIdentifierForFullPath() {
  const { identifierFor } = __testing;
  // The full path is preserved for the hover tooltip even though the canvas
  // label is shortened to the basename.
  assert.equal(
    identifierFor({ node: { type: "File", path: "/src/app/auth.py" } }),
    "/src/app/auth.py"
  );
  assert.equal(identifierFor({ node: { canonical_name: "nn" } }), "nn");
  assert.equal(identifierFor({ id: "x1" }), "x1");
}

function testHighlightIdsFromProps() {
  assert.deepEqual(__testing.highlightIdsFromProps(null), []);
  assert.deepEqual(__testing.highlightIdsFromProps({ selectedNodeId: "x" }), ["x"]);
  assert.deepEqual(__testing.highlightIdsFromProps({ highlightNodeId: 7 }), ["7"]);
  assert.deepEqual(__testing.highlightIdsFromProps({ highlightNodeIds: ["a", null, "b"] }), [
    "a",
    "b"
  ]);
}

function testNodeMatchesProps() {
  assert.equal(nodeMatchesProps({ layer: 2 }, { focusedLayer: 2 }), true);
  assert.equal(nodeMatchesProps({ layer: 3 }, { focusedLayer: 2 }), false);
  assert.equal(nodeMatchesProps({ layer: 3 }, {}), true);
  assert.equal(nodeMatchesProps({}, { focusedLayer: 2 }), true); // no layer → unfiltered
}

// ---------------------------------------------------------------------------
// Factory + mount lifecycle
// ---------------------------------------------------------------------------

function testFactoryReturnsMountShape() {
  const r = createForceGraph2DRenderer({ loader: () => Promise.resolve(stubForceGraph()) });
  assert.equal(typeof r.mount, "function");
}

function testFactoryIsLazyAndDoesNotCallLoader() {
  let called = false;
  createForceGraph2DRenderer({
    loader: () => {
      called = true;
      return Promise.resolve(stubForceGraph());
    }
  });
  assert.equal(called, false, "loader must not run until mount()");
}

async function testMountReturnsSyncHandle() {
  const r = createForceGraph2DRenderer({ loader: () => Promise.resolve(stubForceGraph()) });
  const handle = r.mount(fakeHost(), kg3dLayout(), {});
  assert.equal(typeof handle.update, "function");
  assert.equal(typeof handle.dispose, "function");
  await flushAsync();
}

async function testMountCallsLoaderAndAppliesData() {
  const ForceGraph = stubForceGraph();
  const r = createForceGraph2DRenderer({ loader: () => Promise.resolve(ForceGraph) });
  r.mount(fakeHost(), kg3dLayout(), {});
  await flushAsync();
  const inst = ForceGraph._instance;
  const gd = inst._calls.find((c) => c[0] === "graphData");
  assert.ok(gd, "graphData should be applied after load");
  assert.equal(gd[1][0].nodes.length, 2);
  assert.equal(gd[1][0].links.length, 1);
  // The organic style accessors were wired.
  assert.ok(inst._calls.some((c) => c[0] === "nodeCanvasObject"));
  assert.ok(inst._calls.some((c) => c[0] === "linkDirectionalParticles"));
}

async function testUpdateAfterLoadAppliesData() {
  const ForceGraph = stubForceGraph();
  const r = createForceGraph2DRenderer({ loader: () => Promise.resolve(ForceGraph) });
  const handle = r.mount(fakeHost(), kg3dLayout(), {});
  await flushAsync();
  handle.update(lineageLayout(), {});
  const inst = ForceGraph._instance;
  assert.equal(inst._data.nodes.length, 3, "latest layout applied on update");
}

async function testUpdateBeforeLoadIsReplayedOnActivation() {
  const ForceGraph = stubForceGraph();
  const d = delayedLoader(ForceGraph);
  const r = createForceGraph2DRenderer({ loader: d.loader });
  const handle = r.mount(fakeHost(), kg3dLayout(), {});
  // Update arrives BEFORE the loader resolves — should be stashed + replayed.
  handle.update(lineageLayout(), {});
  await d.flush();
  await flushAsync();
  assert.equal(ForceGraph._instance._data.nodes.length, 3);
}

async function testDisposeBeforeLoadCancelsActivation() {
  const ForceGraph = stubForceGraph();
  const d = delayedLoader(ForceGraph);
  const r = createForceGraph2DRenderer({ loader: d.loader });
  const handle = r.mount(fakeHost(), kg3dLayout(), {});
  handle.dispose();
  await d.flush();
  await flushAsync();
  // Disposed before activation → instance never received data.
  assert.equal(ForceGraph._instance._data, null);
}

async function testDisposeAfterLoadCallsDestructor() {
  const ForceGraph = stubForceGraph();
  const host = fakeHost();
  const r = createForceGraph2DRenderer({ loader: () => Promise.resolve(ForceGraph) });
  const handle = r.mount(host, kg3dLayout(), {});
  await flushAsync();
  handle.dispose();
  assert.equal(ForceGraph._instance._destroyed, true);
  assert.equal(host.innerHTML, "");
}

async function testLoaderErrorPaintsInlineError() {
  const host = fakeHost();
  const r = createForceGraph2DRenderer({ loader: () => Promise.reject(new Error("boom")) });
  r.mount(host, kg3dLayout(), {});
  await flushAsync();
  assert.match(host.innerHTML, /Graph renderer failed/);
  assert.match(host.innerHTML, /boom/);
}

async function testLoaderReturnsNonFunctionPaintsInlineError() {
  const host = fakeHost();
  const r = createForceGraph2DRenderer({ loader: () => Promise.resolve({}) });
  r.mount(host, kg3dLayout(), {});
  await flushAsync();
  assert.match(host.innerHTML, /Graph renderer failed/);
}

async function testOnSelectWiresThroughOnClick() {
  const ForceGraph = stubForceGraph();
  let factoryClicked = null;
  let propClicked = null;
  const r = createForceGraph2DRenderer({
    loader: () => Promise.resolve(ForceGraph),
    onNodeClick: (id) => {
      factoryClicked = id;
    }
  });
  r.mount(fakeHost(), kg3dLayout(), { onSelect: (id) => (propClicked = id) });
  await flushAsync();
  const onClick = ForceGraph._instance._handlers.onNodeClick;
  onClick({ id: "neural_nets" });
  // props.onSelect takes precedence; the factory handler does NOT double-fire.
  assert.equal(propClicked, "neural_nets");
  assert.equal(factoryClicked, null);
}

async function testFactoryClickFiresWhenNoOnSelect() {
  const ForceGraph = stubForceGraph();
  let factoryClicked = null;
  const r = createForceGraph2DRenderer({
    loader: () => Promise.resolve(ForceGraph),
    onNodeClick: (id) => (factoryClicked = id)
  });
  r.mount(fakeHost(), kg3dLayout(), {}); // no onSelect in props
  await flushAsync();
  ForceGraph._instance._handlers.onNodeClick({ id: "backprop" });
  assert.equal(factoryClicked, "backprop");
}

async function testLayerFilterDropsHiddenNodes() {
  const ForceGraph = stubForceGraph();
  const r = createForceGraph2DRenderer({ loader: () => Promise.resolve(ForceGraph) });
  // focusedLayer=1 should keep only the layer-1 node and drop the layer-3 one,
  // and any link touching the hidden node.
  r.mount(fakeHost(), kg3dLayout(), { focusedLayer: 1 });
  await flushAsync();
  const data = ForceGraph._instance._data;
  assert.equal(data.nodes.length, 1);
  assert.equal(data.nodes[0].id, "neural_nets");
  assert.equal(data.links.length, 0);
}

function testMountRejectsBadHost() {
  const r = createForceGraph2DRenderer({ loader: () => Promise.resolve(stubForceGraph()) });
  assert.throws(() => r.mount(null, kg3dLayout(), {}), /host must be an HTMLElement/);
  assert.throws(() => r.mount({}, kg3dLayout(), {}), /host must be an HTMLElement/);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
