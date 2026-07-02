#!/usr/bin/env node
//
// ADR-001 Phase C follow-up — three-renderer drop-in.
//
// Renders into a fake DOM host (the renderer never reaches DOM APIs
// outside `host.innerHTML` and `host.querySelector` existence checks).
// The `3d-force-graph` lib is stubbed via `options.loader` so this
// node-runner test never touches the CDN.

import assert from "node:assert/strict";

import {
  createThreeRenderer,
  layoutToGraphData,
  nodeMatchesProps,
  labelFor,
  identifierFor,
  __testing
} from "../app/L0/_all/mod/_prime_silo/widgets/three_renderer/index.js";

async function main() {
  // layoutToGraphData — pure normaliser. No DOM, no async.
  testLayoutToGraphDataEmpty();
  testLayoutToGraphDataKg3dShape();
  testLayoutToGraphDataCodegraphShape();
  testLayoutToGraphDataDropsEdgesWithMissingEnds();
  testLayoutToGraphDataPinsXYAsFxFy();
  testLayoutToGraphDataFluidSeedsXY();
  testLayoutToGraphDataCoercesEdgeIdsToStrings();
  testLayoutToGraphDataCarriesOriginalNode();

  // createThreeRenderer — factory + mount + lazy-load lifecycle.
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
  await testOnNodeClickWiresThrough();
  await testMultipleMountsAreIndependent();
  testMountRejectsBadHost();

  // Filters (focusedLayer) — node/link visibility predicates.
  testNodeMatchesProps();
  await testFocusedLayerAppliesVisibility();

  // Camera framing — zoomToFit on engine settle.
  await testFitsToViewOnEngineStop();
  await testRefitsAfterDataUpdate();
  await testFitOnLoadDisabledSkipsFit();

  // Labels + force spacing.
  testLabelForAndIdentifier();
  testLayoutAttachesNameAndIdent();
  await testForceSpacingApplied();
  await testLabelsAttachWhenSpriteLoads();
  await testLabelsDisabledSkipsSprite();

  console.log("widgets_three_renderer_test: ok");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeHost() {
  const host = {
    innerHTML: "",
    classList: { add() {}, remove() {} },
    querySelector() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {}
  };
  return host;
}

function stubForceGraph3D() {
  // Mirrors 3d-force-graph's curried/fluent API. The instance records
  // every call so tests can assert on the wire shape.
  const instance = {
    _calls: [],
    _destroyed: false,
    backgroundColor(...args) {
      this._calls.push(["backgroundColor", args]);
      return this;
    },
    nodeRelSize(...args) {
      this._calls.push(["nodeRelSize", args]);
      return this;
    },
    nodeColor(...args) {
      this._calls.push(["nodeColor", args]);
      return this;
    },
    linkColor(...args) {
      this._calls.push(["linkColor", args]);
      return this;
    },
    onNodeClick(...args) {
      this._calls.push(["onNodeClick", args]);
      return this;
    },
    graphData(...args) {
      this._calls.push(["graphData", args]);
      return this;
    },
    _destructor() {
      this._destroyed = true;
    }
  };
  // The lib exports a factory of the form ForceGraph3D() returns a
  // function that takes the dom element and returns the instance.
  const ForceGraph3D = () => (host) => {
    instance._host = host;
    return instance;
  };
  ForceGraph3D._instance = instance;
  return ForceGraph3D;
}

// Flush ALL pending microtasks. The renderer's activation chain is
// `Promise.resolve().then(loader).then(activate)`, so it takes several
// microtasks to drain; setTimeout(0) yields to the macrotask queue which
// only runs after every microtask is done.
function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function delayedLoader(ForceGraph3D) {
  // Resolves the loader on the next microtask so we can interleave
  // mount → update → dispose calls with the load lifecycle.
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return {
    loader: () => promise,
    flush() {
      resolve(ForceGraph3D);
      return promise;
    }
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
        node: { id: "neural_nets", canonical_name: "Neural networks" }
      },
      backprop: {
        x: 200,
        y: 140,
        radius: 8,
        layer: 3,
        color: "#22d3ee",
        node: { id: "backprop" }
      }
    },
    edges: [
      { id: "e1", source: "neural_nets", target: "backprop", kind: "prerequisite", weight: 0.9 }
    ],
    width: 720,
    height: 480
  };
}

function codegraphLayout() {
  return {
    positions: {
      "/src/foo.py": {
        x: 50,
        y: 30,
        radius: 6,
        type: "File",
        color: "#00FFFF",
        node: { id: "/src/foo.py", type: "File", path: "/src/foo.py" }
      },
      "Foo.bar": {
        x: 200,
        y: 60,
        radius: 6,
        type: "Function",
        color: "#FF5F1F",
        node: { id: "Foo.bar", type: "Function" }
      }
    },
    edges: [{ id: "e1", source: "/src/foo.py", target: "Foo.bar", type: "DEFINES" }]
  };
}

// ---------------------------------------------------------------------------
// layoutToGraphData
// ---------------------------------------------------------------------------

function testLayoutToGraphDataEmpty() {
  assert.deepEqual(layoutToGraphData(null), { nodes: [], links: [] });
  assert.deepEqual(layoutToGraphData({}), { nodes: [], links: [] });
  assert.deepEqual(layoutToGraphData({ positions: {}, edges: [] }), { nodes: [], links: [] });
}

function testLayoutToGraphDataKg3dShape() {
  const out = layoutToGraphData(kg3dLayout());
  assert.equal(out.nodes.length, 2);
  const byId = Object.fromEntries(out.nodes.map((n) => [n.id, n]));
  assert.equal(byId.neural_nets.color, "#a78bfa");
  assert.equal(byId.neural_nets.val, 12);
  assert.equal(byId.neural_nets.layer, 1);
  assert.equal(byId.backprop.layer, 3);
  // kg3d carries no `type`, so neither should the graph node.
  assert.equal("type" in byId.neural_nets, false);
  assert.equal(out.links.length, 1);
  assert.equal(out.links[0].kind, "prerequisite");
  assert.equal(out.links[0].weight, 0.9);
  // codegraph-style `type` is absent.
  assert.equal("type" in out.links[0], false);
}

function testLayoutToGraphDataCodegraphShape() {
  const out = layoutToGraphData(codegraphLayout());
  assert.equal(out.nodes.length, 2);
  const byId = Object.fromEntries(out.nodes.map((n) => [n.id, n]));
  assert.equal(byId["/src/foo.py"].type, "File");
  assert.equal(byId["Foo.bar"].type, "Function");
  assert.equal(out.links.length, 1);
  assert.equal(out.links[0].type, "DEFINES");
  // kg3d-style `kind` and `weight` are absent.
  assert.equal("kind" in out.links[0], false);
  assert.equal("weight" in out.links[0], false);
}

function testLayoutToGraphDataDropsEdgesWithMissingEnds() {
  const out = layoutToGraphData({
    positions: { a: { x: 0, y: 0, color: "#fff" } },
    edges: [
      { source: "a", target: "b" }, // kept — normaliser doesn't reach into positions for validity
      { source: "a" }, // dropped — no target
      { target: "b" }, // dropped — no source
      { source: null, target: "b" }, // dropped — null source
      null // dropped — null edge
    ]
  });
  // The renderer's job is to forward what it's given; positional validity
  // is the widget's contract. But we DO drop edges that can't even form a
  // link record. So only the first survives.
  assert.equal(out.links.length, 1);
  assert.equal(out.links[0].source, "a");
  assert.equal(out.links[0].target, "b");
}

function testLayoutToGraphDataPinsXYAsFxFy() {
  // 2D layout coordinates seed the 3D solver via fx/fy. Without this, the
  // 3D scene would lose the AoT-layer / type-band grouping that makes the
  // 2D fallback legible.
  const out = layoutToGraphData(kg3dLayout());
  const neural = out.nodes.find((n) => n.id === "neural_nets");
  assert.equal(neural.fx, 100);
  assert.equal(neural.fy, 50);
}

function testLayoutToGraphDataFluidSeedsXY() {
  // When physicsMode is "fluid", nodes should not be pinned (fx/fy are undefined),
  // but instead have initial x/y coordinates seeded.
  const out = layoutToGraphData(kg3dLayout(), "fluid");
  const neural = out.nodes.find((n) => n.id === "neural_nets");
  assert.equal(neural.fx, undefined);
  assert.equal(neural.fy, undefined);
  assert.equal(neural.x, 100);
  assert.equal(neural.y, 50);
}

function testLayoutToGraphDataCoercesEdgeIdsToStrings() {
  // Codegraph IDs are sometimes numeric (Neo4j internal ids). Force them
  // to strings so they line up with the node ids the normaliser emits.
  const out = layoutToGraphData({
    positions: { 42: { x: 0, y: 0 } },
    edges: [{ source: 42, target: "42" }]
  });
  assert.equal(out.links[0].source, "42");
  assert.equal(out.links[0].target, "42");
}

function testLayoutToGraphDataCarriesOriginalNode() {
  const out = layoutToGraphData(codegraphLayout());
  const fn = out.nodes.find((n) => n.id === "Foo.bar");
  assert.equal(fn._original.type, "Function");
}

// ---------------------------------------------------------------------------
// Factory + mount lifecycle
// ---------------------------------------------------------------------------

function testFactoryReturnsMountShape() {
  const r = createThreeRenderer({ loader: () => Promise.resolve(stubForceGraph3D()) });
  assert.equal(typeof r.mount, "function");
}

function testFactoryIsLazyAndDoesNotCallLoader() {
  let called = 0;
  createThreeRenderer({
    loader: () => {
      called += 1;
      return Promise.resolve(stubForceGraph3D());
    }
  });
  assert.equal(called, 0, "factory must not call loader at construction");
}

async function testMountReturnsSyncHandle() {
  const ForceGraph3D = stubForceGraph3D();
  const { loader, flush } = delayedLoader(ForceGraph3D);
  const r = createThreeRenderer({ loader });
  const handle = r.mount(fakeHost(), kg3dLayout(), {});
  // Handle MUST be synchronous so widgets can assign it to rendererHandle
  // without await.
  assert.equal(typeof handle.update, "function");
  assert.equal(typeof handle.dispose, "function");
  // Loader runs but hasn't resolved yet — no calls on the instance.
  await flushAsync();
  assert.equal(ForceGraph3D._instance._calls.length, 0);
  handle.dispose();
  await flush().catch(() => {}); // unblock the promise chain to avoid unhandled-rejection noise
  await flushAsync();
}

async function testMountCallsLoaderAndAppliesData() {
  let calls = 0;
  const ForceGraph3D = stubForceGraph3D();
  const r = createThreeRenderer({
    loader: () => {
      calls += 1;
      return Promise.resolve(ForceGraph3D);
    }
  });
  const host = fakeHost();
  r.mount(host, kg3dLayout(), {});
  // Wait for the load promise + the internal then chain to flush.
  await flushAsync();
  assert.equal(calls, 1, "loader must be called exactly once");
  const inst = ForceGraph3D._instance;
  const methods = inst._calls.map((c) => c[0]);
  assert.ok(methods.includes("backgroundColor"));
  assert.ok(methods.includes("nodeRelSize"));
  assert.ok(methods.includes("nodeColor"));
  assert.ok(methods.includes("linkColor"));
  // graphData must have been called with the normalised payload.
  const dataCall = inst._calls.find((c) => c[0] === "graphData");
  assert.ok(dataCall, "graphData must be called after load");
  assert.equal(dataCall[1][0].nodes.length, 2);
  assert.equal(dataCall[1][0].links.length, 1);
}

async function testUpdateAfterLoadAppliesData() {
  const ForceGraph3D = stubForceGraph3D();
  const r = createThreeRenderer({ loader: () => Promise.resolve(ForceGraph3D) });
  const handle = r.mount(fakeHost(), kg3dLayout(), {});
  await flushAsync();
  const before = ForceGraph3D._instance._calls.filter((c) => c[0] === "graphData").length;
  handle.update(codegraphLayout(), {});
  const after = ForceGraph3D._instance._calls.filter((c) => c[0] === "graphData").length;
  assert.equal(after, before + 1, "update must call graphData once more");
}

async function testUpdateBeforeLoadIsReplayedOnActivation() {
  // Mount with layout A, immediately update to layout B, THEN let the
  // loader resolve. The instance must see layout B (the latest), not A.
  const ForceGraph3D = stubForceGraph3D();
  const { loader, flush } = delayedLoader(ForceGraph3D);
  const r = createThreeRenderer({ loader });
  const handle = r.mount(fakeHost(), kg3dLayout(), {});
  handle.update(codegraphLayout(), {});
  await flush();
  // Allow the chained .then to run.
  await flushAsync();
  const dataCall = ForceGraph3D._instance._calls.find((c) => c[0] === "graphData");
  assert.ok(dataCall, "graphData must be called on activation");
  // codegraph layout has node ids "/src/foo.py" and "Foo.bar".
  const ids = dataCall[1][0].nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["/src/foo.py", "Foo.bar"].sort());
}

async function testDisposeBeforeLoadCancelsActivation() {
  const ForceGraph3D = stubForceGraph3D();
  const { loader, flush } = delayedLoader(ForceGraph3D);
  const r = createThreeRenderer({ loader });
  const handle = r.mount(fakeHost(), kg3dLayout(), {});
  handle.dispose();
  await flush();
  await flushAsync();
  // The factory function was never invoked because dispose flipped the
  // cancellation flag before the .then ran.
  assert.equal(
    ForceGraph3D._instance._calls.length,
    0,
    "disposed mount must not interact with the lib instance"
  );
}

async function testDisposeAfterLoadCallsDestructor() {
  const ForceGraph3D = stubForceGraph3D();
  const r = createThreeRenderer({ loader: () => Promise.resolve(ForceGraph3D) });
  const host = fakeHost();
  const handle = r.mount(host, kg3dLayout(), {});
  await flushAsync();
  handle.dispose();
  assert.equal(
    ForceGraph3D._instance._destroyed,
    true,
    "dispose after load must call _destructor on the 3d-force-graph instance"
  );
  assert.equal(host.innerHTML, "");
}

async function testLoaderErrorPaintsInlineError() {
  const r = createThreeRenderer({
    loader: () => Promise.reject(new Error("network blew up"))
  });
  const host = fakeHost();
  r.mount(host, kg3dLayout(), {});
  await flushAsync();
  assert.match(host.innerHTML, /3D renderer failed/);
  assert.match(host.innerHTML, /network blew up/);
}

async function testLoaderReturnsNonFunctionPaintsInlineError() {
  // Defensive: a bad CDN endpoint that returns a module without a default
  // export is a real failure mode. Surface it the same way as a network
  // error rather than throwing in the activation chain.
  const r = createThreeRenderer({
    loader: () => Promise.resolve({ weird: true })
  });
  const host = fakeHost();
  r.mount(host, kg3dLayout(), {});
  await flushAsync();
  assert.match(host.innerHTML, /3D renderer failed/);
  assert.match(host.innerHTML, /ForceGraph3D constructor/);
}

async function testOnNodeClickWiresThrough() {
  const ForceGraph3D = stubForceGraph3D();
  let receivedId = null;
  const r = createThreeRenderer({
    loader: () => Promise.resolve(ForceGraph3D),
    onNodeClick: (id) => {
      receivedId = id;
    }
  });
  r.mount(fakeHost(), kg3dLayout(), {});
  await flushAsync();
  // The instance recorded the onNodeClick registration with a handler;
  // invoke it as 3d-force-graph would on a click.
  const clickReg = ForceGraph3D._instance._calls.find((c) => c[0] === "onNodeClick");
  assert.ok(clickReg, "onNodeClick must be registered on the instance");
  const handler = clickReg[1][0];
  handler({ id: "neural_nets" });
  assert.equal(receivedId, "neural_nets");
}

async function testMultipleMountsAreIndependent() {
  // Two mounts off the same factory must hold independent state. The
  // renderer is a factory not a singleton — disposing one must not
  // affect the other.
  const instanceA = stubForceGraph3D()._instance;
  const instanceB = stubForceGraph3D()._instance;
  let nextInstance = instanceA;
  const ForceGraph3D = () => (host) => {
    const inst = nextInstance;
    inst._host = host;
    nextInstance = nextInstance === instanceA ? instanceB : instanceA;
    return inst;
  };
  const r = createThreeRenderer({ loader: () => Promise.resolve(ForceGraph3D) });
  const h1 = r.mount(fakeHost(), kg3dLayout(), {});
  const h2 = r.mount(fakeHost(), codegraphLayout(), {});
  await flushAsync();
  h1.dispose();
  assert.equal(instanceA._destroyed, true);
  assert.equal(instanceB._destroyed, false, "disposing one mount must not affect the other");
  h2.dispose();
  assert.equal(instanceB._destroyed, true);
}

function testMountRejectsBadHost() {
  const r = createThreeRenderer({ loader: () => Promise.resolve(stubForceGraph3D()) });
  assert.throws(() => r.mount(null, kg3dLayout(), {}), /host must be an HTMLElement/);
  assert.throws(() => r.mount({}, kg3dLayout(), {}), /host must be an HTMLElement/);
}

// ---------------------------------------------------------------------------
// Filters — focusedLayer
// ---------------------------------------------------------------------------

function testNodeMatchesProps() {
  // No filter → everything visible.
  assert.equal(nodeMatchesProps({ layer: 1 }, {}), true);
  assert.equal(nodeMatchesProps({ layer: 1 }, { focusedLayer: 0 }), true);
  // Focused layer keeps matching nodes, hides others.
  assert.equal(nodeMatchesProps({ layer: 1 }, { focusedLayer: 1 }), true);
  assert.equal(nodeMatchesProps({ layer: 3 }, { focusedLayer: 1 }), false);
  // Nodes without a layer (e.g. code graph) are never hidden by a layer focus.
  assert.equal(nodeMatchesProps({}, { focusedLayer: 1 }), true);
}

function stubForceGraph3DWithVisibility() {
  const base = stubForceGraph3D();
  const instance = base._instance;
  instance.nodeVisibility = function nodeVisibility(...args) {
    this._calls.push(["nodeVisibility", args]);
    this._nodeVisibility = args[0];
    return this;
  };
  instance.linkVisibility = function linkVisibility(...args) {
    this._calls.push(["linkVisibility", args]);
    this._linkVisibility = args[0];
    return this;
  };
  return base;
}

async function testFocusedLayerAppliesVisibility() {
  const ForceGraph3D = stubForceGraph3DWithVisibility();
  const r = createThreeRenderer({ loader: () => Promise.resolve(ForceGraph3D) });
  const handle = r.mount(fakeHost(), kg3dLayout(), { focusedLayer: 1 });
  await flushAsync();
  const inst = ForceGraph3D._instance;
  assert.equal(typeof inst._nodeVisibility, "function", "nodeVisibility accessor registered");
  assert.equal(typeof inst._linkVisibility, "function", "linkVisibility accessor registered");
  // kg3dLayout has neural_nets@layer1 and backprop@layer3 — focus on 1.
  assert.equal(inst._nodeVisibility({ layer: 1 }), true);
  assert.equal(inst._nodeVisibility({ layer: 3 }), false);
  // A link is visible only when both processed endpoints survive.
  assert.equal(inst._linkVisibility({ source: { layer: 1 }, target: { layer: 1 } }), true);
  assert.equal(inst._linkVisibility({ source: { layer: 1 }, target: { layer: 3 } }), false);
  // Clearing the focus (update with no focusedLayer) re-opens everything.
  handle.update(kg3dLayout(), {});
  assert.equal(inst._nodeVisibility({ layer: 3 }), true);
}

// ---------------------------------------------------------------------------
// Camera framing — zoomToFit
// ---------------------------------------------------------------------------

function stubForceGraph3DWithFit() {
  const base = stubForceGraph3D();
  const instance = base._instance;
  instance.zoomToFit = function zoomToFit(...args) {
    this._calls.push(["zoomToFit", args]);
    this._fitCount = (this._fitCount || 0) + 1;
    return this;
  };
  instance.onEngineStop = function onEngineStop(...args) {
    this._calls.push(["onEngineStop", args]);
    this._engineStop = args[0];
    return this;
  };
  return base;
}

async function testFitsToViewOnEngineStop() {
  const ForceGraph3D = stubForceGraph3DWithFit();
  const r = createThreeRenderer({ loader: () => Promise.resolve(ForceGraph3D) });
  r.mount(fakeHost(), kg3dLayout(), {});
  await flushAsync();
  const inst = ForceGraph3D._instance;
  assert.equal(typeof inst._engineStop, "function", "onEngineStop handler must be registered");
  assert.equal(inst._fitCount || 0, 0, "no fit before the engine settles");
  // Simulate 3d-force-graph cooling down.
  inst._engineStop();
  assert.equal(inst._fitCount, 1, "engine settle must frame the graph once");
  // A second settle without new data must NOT re-fit (would fight the user's pan/zoom).
  inst._engineStop();
  assert.equal(inst._fitCount, 1, "no re-fit without new data");
}

async function testRefitsAfterDataUpdate() {
  const ForceGraph3D = stubForceGraph3DWithFit();
  const r = createThreeRenderer({ loader: () => Promise.resolve(ForceGraph3D) });
  const handle = r.mount(fakeHost(), kg3dLayout(), {});
  await flushAsync();
  const inst = ForceGraph3D._instance;
  inst._engineStop();
  assert.equal(inst._fitCount, 1);
  // New data → reheat → settle → one more fit.
  handle.update(codegraphLayout(), {});
  inst._engineStop();
  assert.equal(inst._fitCount, 2, "new data must re-frame on the next settle");
}

async function testFitOnLoadDisabledSkipsFit() {
  const ForceGraph3D = stubForceGraph3DWithFit();
  const r = createThreeRenderer({
    loader: () => Promise.resolve(ForceGraph3D),
    fitOnLoad: false
  });
  r.mount(fakeHost(), kg3dLayout(), {});
  await flushAsync();
  const inst = ForceGraph3D._instance;
  // With fitting off, the onEngineStop handler is never registered.
  assert.equal(
    inst._engineStop,
    undefined,
    "onEngineStop must not be registered when fitOnLoad=false"
  );
  assert.equal(inst._fitCount || 0, 0);
}

// ---------------------------------------------------------------------------
// Labels + force spacing
// ---------------------------------------------------------------------------

function testLabelForAndIdentifier() {
  // kg3d shape — display_name wins.
  assert.equal(
    labelFor({ node: { display_name: "Neural networks", id: "nn" } }),
    "Neural networks"
  );
  // codegraph shape — File path collapses to basename on the label, full path
  // on the identifier.
  assert.equal(labelFor({ node: { id: "/src/app/auth.py", type: "File" } }), "auth.py");
  assert.equal(
    identifierFor({ node: { id: "/src/app/auth.py", type: "File" } }),
    "/src/app/auth.py"
  );
  // Bare type fallback when nothing nameable exists.
  assert.equal(labelFor({ node: { type: "Concept" } }), "Concept");
}

function testLayoutAttachesNameAndIdent() {
  const out = layoutToGraphData(codegraphLayout());
  const file = out.nodes.find((n) => n.id === "/src/foo.py");
  assert.equal(file.name, "foo.py", "label collapses path to basename");
  assert.equal(file.ident, "/src/foo.py", "ident keeps the full path");
}

function stubForceGraph3DWithForces() {
  const base = stubForceGraph3D();
  const instance = base._instance;
  instance._forces = {};
  instance.d3Force = function d3Force(name) {
    this._calls.push(["d3Force", [name]]);
    if (!this._forces[name]) {
      const f = {};
      f.strength = (v) => {
        f._strength = v;
        return f;
      };
      f.distance = (v) => {
        f._distance = v;
        return f;
      };
      this._forces[name] = f;
    }
    return this._forces[name];
  };
  instance.nodeLabel = function nodeLabel(...args) {
    this._calls.push(["nodeLabel", args]);
    this._nodeLabel = args[0];
    return this;
  };
  return base;
}

async function testForceSpacingApplied() {
  const ForceGraph3D = stubForceGraph3DWithForces();
  const r = createThreeRenderer({ loader: () => Promise.resolve(ForceGraph3D) });
  r.mount(fakeHost(), kg3dLayout(), {});
  await flushAsync();
  const inst = ForceGraph3D._instance;
  // Charge must be strengthened (more negative than the lib default of -30).
  assert.ok(inst._forces.charge._strength < -30, "charge repulsion must be strengthened");
  assert.ok(inst._forces.link._distance > 30, "link distance must be lengthened");
  // Hover tooltip wired with a function.
  assert.equal(typeof inst._nodeLabel, "function");
  assert.match(inst._nodeLabel({ name: "Neural networks", ident: "nn" }), /Neural networks/);
}

function stubForceGraph3DWithLabels() {
  const base = stubForceGraph3DWithForces();
  const instance = base._instance;
  instance.nodeThreeObject = function nodeThreeObject(...args) {
    this._calls.push(["nodeThreeObject", args]);
    this._nodeThreeObject = args[0];
    return this;
  };
  instance.nodeThreeObjectExtend = function nodeThreeObjectExtend(...args) {
    this._calls.push(["nodeThreeObjectExtend", args]);
    this._extend = args[0];
    return this;
  };
  return base;
}

// Minimal SpriteText double — records the text and exposes a position object.
function FakeSpriteText(text) {
  this.text = text;
  this.position = {
    _xyz: null,
    set(x, y, z) {
      this._xyz = [x, y, z];
    }
  };
}

async function testLabelsAttachWhenSpriteLoads() {
  const ForceGraph3D = stubForceGraph3DWithLabels();
  const r = createThreeRenderer({
    loader: () => Promise.resolve(ForceGraph3D),
    labelLoader: () => Promise.resolve(FakeSpriteText)
  });
  r.mount(fakeHost(), kg3dLayout(), {});
  await flushAsync();
  await flushAsync(); // label loader resolves on a later microtask turn
  const inst = ForceGraph3D._instance;
  assert.equal(typeof inst._nodeThreeObject, "function", "nodeThreeObject accessor registered");
  assert.equal(inst._extend, true, "sphere kept alongside the label sprite");
  const sprite = inst._nodeThreeObject({ name: "Backprop", id: "backprop", val: 8 });
  assert.equal(sprite.text, "Backprop", "sprite shows the friendly name");
  assert.ok(Array.isArray(sprite.position._xyz), "label is offset off the node");
}

async function testLabelsDisabledSkipsSprite() {
  let labelLoaderCalls = 0;
  const ForceGraph3D = stubForceGraph3DWithLabels();
  const r = createThreeRenderer({
    loader: () => Promise.resolve(ForceGraph3D),
    showLabels: false,
    labelLoader: () => {
      labelLoaderCalls += 1;
      return Promise.resolve(FakeSpriteText);
    }
  });
  r.mount(fakeHost(), kg3dLayout(), {});
  await flushAsync();
  await flushAsync();
  assert.equal(labelLoaderCalls, 0, "label loader must not run when showLabels=false");
  assert.equal(ForceGraph3D._instance._nodeThreeObject, undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Exported constants — sanity check the public surface didn't drift.
assert.equal(typeof __testing.DEFAULT_CDN_URL, "string");
assert.match(__testing.DEFAULT_CDN_URL, /3d-force-graph/);
