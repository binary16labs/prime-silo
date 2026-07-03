#!/usr/bin/env node
//
// ADR-001 Phase C — kg3d.synoptic_web widget tests.
//
// Seventh migrated widget; second graph-shaped after dag.canvas. Tests
// cover the runtime fetch path, the layered layout algorithm, palette
// fallbacks, the focused-layer fade, click delegation, the inline-data
// fast path that bypasses the fetch, and the pluggable-renderer hook
// (so future Three.js renderers can land without touching this suite).

import assert from "node:assert/strict";

import {
  createSynopticWebWidget,
  __testing as kgTesting
} from "../app/L0/_all/mod/_prime_silo/widgets/kg3d/synoptic_web/index.js";

async function main() {
  testBuildOntologyPath();
  testClampLayer();
  testPickCategoryAndEdgeColors();
  testComputeLayoutBucketsByLayer();
  testComputeLayoutDropsDanglingEdges();
  testRenderSvgIncludesLayerGuidesAndNodes();
  testRenderEdgeFocusFade();
  await testWidgetLoadsViaFetch();
  await testWidgetRendersFromInlineData();
  await testWidgetSurfacesError();
  await testWidgetEmptyOntology();
  await testWidgetGraphFullFallbackBudget();
  await testWidgetUpdateReloadsOnWorkspaceChange();
  await testWidgetUpdateRepaintsOnFocusedLayer();
  await testWidgetCustomRendererReceivesLayout();
  await testWidgetClickInvokesOnSelect();
  await testWidgetDestroyClearsHostAndDisposesRenderer();
  console.log("widgets_kg3d_synoptic_web_test: ok");
}

function testBuildOntologyPath() {
  assert.equal(kgTesting.buildOntologyPath({}), "/kg3d/ontology?workspace=default");
  assert.equal(
    kgTesting.buildOntologyPath({ workspace: "c4_test" }),
    "/kg3d/ontology?workspace=c4_test"
  );
}

function testClampLayer() {
  assert.equal(kgTesting.clampLayer(0), kgTesting.MIN_LAYER);
  assert.equal(kgTesting.clampLayer(7), kgTesting.MAX_LAYER);
  assert.equal(kgTesting.clampLayer(2.7), 3);
  assert.equal(kgTesting.clampLayer(undefined), 3);
}

function testPickCategoryAndEdgeColors() {
  assert.equal(
    kgTesting.pickCategoryColor("ai_deep_learning"),
    kgTesting.CATEGORY_COLORS.ai_deep_learning
  );
  assert.equal(kgTesting.pickCategoryColor("not_a_category"), kgTesting.CATEGORY_COLORS.default);
  assert.equal(kgTesting.pickCategoryColor(undefined), kgTesting.CATEGORY_COLORS.default);

  assert.equal(kgTesting.pickEdgeColor("prerequisite"), kgTesting.EDGE_COLORS.prerequisite);
  assert.equal(kgTesting.pickEdgeColor("references"), kgTesting.EDGE_COLORS.references);
  assert.equal(kgTesting.pickEdgeColor("weird"), kgTesting.EDGE_COLORS.default);
}

function testComputeLayoutBucketsByLayer() {
  const nodes = [
    { id: "a", aot_layer: 1, category: "ai_deep_learning", metrics: { pagerank: 100 } },
    { id: "b", aot_layer: 2, category: "neural_evolutionary_computing", metrics: { pagerank: 50 } },
    { id: "c", aot_layer: 2, category: "neural_evolutionary_computing", metrics: { pagerank: 25 } },
    { id: "d", aot_layer: 4, metrics: { pagerank: 0 } } // unknown category falls back
  ];
  const edges = [
    { source_id: "a", target_id: "b", kind: "prerequisite" },
    { source_id: "b", target_id: "c", kind: "references" }
  ];
  const layout = kgTesting.computeLayout(nodes, edges);
  // a is alone in layer 1 — should be centred.
  assert.ok(layout.positions.a);
  assert.ok(layout.positions.b);
  assert.ok(layout.positions.c);
  assert.ok(layout.positions.d);
  // Layer 2 has b and c — they share a y coordinate.
  assert.equal(layout.positions.b.y, layout.positions.c.y);
  // Layer 1 sits above layer 4 (smaller y).
  assert.ok(layout.positions.a.y < layout.positions.d.y);
  // Pagerank weights radius — a (pr=100) is bigger than d (pr=0).
  assert.ok(layout.positions.a.radius > layout.positions.d.radius);
  // Two edges retained.
  assert.equal(layout.edges.length, 2);
  // Layer-bucket map exposed for external use.
  assert.equal(layout.buckets.get(2).length, 2);
  // Unknown-category node uses the default colour.
  assert.equal(layout.positions.d.color, kgTesting.CATEGORY_COLORS.default);
}

function testComputeLayoutDropsDanglingEdges() {
  const nodes = [
    { id: "a", aot_layer: 1, metrics: { pagerank: 50 } },
    { id: "b", aot_layer: 2, metrics: { pagerank: 50 } }
  ];
  const edges = [
    { source_id: "a", target_id: "b" },
    { source_id: "a", target_id: "ghost" }, // dropped
    { source_id: "ghost", target_id: "b" }, // dropped
    { source_id: "a", target_id: "a" } // self-loop dropped
  ];
  const layout = kgTesting.computeLayout(nodes, edges);
  assert.equal(layout.edges.length, 1);
  assert.equal(layout.edges[0].source, "a");
  assert.equal(layout.edges[0].target, "b");
}

function testRenderSvgIncludesLayerGuidesAndNodes() {
  const layout = kgTesting.computeLayout(
    [
      {
        id: "a",
        display_name: "Alpha",
        aot_layer: 1,
        category: "ai_deep_learning",
        metrics: { pagerank: 80 }
      },
      { id: "b", display_name: "Beta", aot_layer: 3, metrics: { pagerank: 40 } }
    ],
    [{ source_id: "a", target_id: "b", kind: "prerequisite" }]
  );
  const svg = kgTesting.renderSvg(layout, {});
  assert.match(svg, /<svg /);
  assert.match(svg, /data-node-id="a"/);
  assert.match(svg, /data-node-id="b"/);
  assert.match(svg, /Alpha/);
  assert.match(svg, /Beta/);
  // Layer guides for L1..L5 should be present.
  assert.match(svg, />L1</);
  assert.match(svg, />L5</);
  // Edge stroke uses the prerequisite colour.
  assert.match(svg, new RegExp(kgTesting.EDGE_COLORS.prerequisite.replace(/[()]/g, "\\$&")));
}

function testRenderEdgeFocusFade() {
  const layout = kgTesting.computeLayout(
    [
      { id: "a", aot_layer: 1, metrics: { pagerank: 40 } },
      { id: "b", aot_layer: 5, metrics: { pagerank: 40 } }
    ],
    [{ source_id: "a", target_id: "b" }]
  );
  // Without focus → edge opacity is the default 0.7.
  const svgUnfocused = kgTesting.renderSvg(layout, {});
  assert.match(svgUnfocused, /stroke-opacity="0.7"/);
  // With focus on layer 3 (which neither endpoint is in) → faded.
  const svgFocused = kgTesting.renderSvg(layout, { focusedLayer: 3 });
  assert.match(svgFocused, /stroke-opacity="0.18"/);
  // Nodes outside the focus also fade.
  assert.match(svgFocused, /opacity="0.18"/);
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
  // Macrotask drain, not just microtasks — the /graph/full fallback adds a
  // second fetch round-trip, and Response.text() can resolve across timers.
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
}

const SAMPLE_ONTOLOGY = {
  nodes: [
    {
      id: "1",
      canonical_name: "AI",
      display_name: "Artificial Intelligence",
      category: "ai_deep_learning",
      aot_layer: 1,
      metrics: { pagerank: 100 }
    },
    {
      id: "2",
      canonical_name: "Neural Networks",
      display_name: "Neural Networks",
      category: "neural_evolutionary_computing",
      aot_layer: 2,
      metrics: { pagerank: 60 }
    }
  ],
  edges: [{ id: "e1", source_id: "1", target_id: "2", kind: "prerequisite" }]
};

async function testWidgetLoadsViaFetch() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = (path) => {
    assert.match(path, /\/kg3d\/ontology\?workspace=c4_test/);
    return jsonResponse(SAMPLE_ONTOLOGY);
  };

  const handle = createSynopticWebWidget(host, { workspace: "c4_test" }, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /Artificial Intelligence/);
  assert.match(host.innerHTML, /Neural Networks/);
  assert.equal(client.calls.length, 1);
  assert.ok(handle.layout);
  assert.ok(handle.layout.positions["1"]);
  assert.ok(handle.layout.positions["2"]);
}

async function testWidgetRendersFromInlineData() {
  const host = createFakeHost();
  const client = createClientStub();
  // No runtimeHandler → fetch would throw if called.
  createSynopticWebWidget(
    host,
    { data: SAMPLE_ONTOLOGY, workspace: "c4_test" },
    { runtimeClient: client }
  );
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /Neural Networks/);
  assert.equal(client.calls.length, 0, "inline data must skip the fetch");
}

async function testWidgetSurfacesError() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => makeRuntimeError(503, "neo4j unavailable");

  createSynopticWebWidget(host, {}, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "error");
  assert.match(host.innerHTML, /neo4j unavailable/);
}

async function testWidgetEmptyOntology() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse({ nodes: [], edges: [] });

  createSynopticWebWidget(host, { workspace: "fresh" }, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /No concepts in workspace/);
  assert.match(host.innerHTML, /<code>fresh<\/code>/);
}

async function testWidgetGraphFullFallbackBudget() {
  // Regression for v1.10.0: a post-synthesis workspace (tens of thousands of
  // concepts) reached the /graph/full fallback and died with "Maximum call
  // stack size exceeded" (spread-max over the degree values). The fallback now
  // caps the view at 400 nodes: every Source plus the most-connected concepts.
  const nodes = [
    { id: "s1", name: "doc-one.md", labels: ["Source"] },
    { id: "s2", name: "doc-two.md", labels: ["Source"] }
  ];
  const edges = [];
  for (let i = 0; i < 1000; i += 1) {
    nodes.push({ id: `c${i}`, name: `Concept ${i}`, labels: ["Concept"] });
    if (i > 0) edges.push({ source: `c${i - 1}`, target: `c${i}` });
  }
  // Make c0 an unmistakable hub so it must survive the cut.
  for (let i = 500; i < 520; i += 1) edges.push({ source: "c0", target: `c${i}` });

  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = (path) =>
    path.startsWith("/graph/full")
      ? jsonResponse({ nodes, edges })
      : jsonResponse({ nodes: [], edges: [] });

  const handle = createSynopticWebWidget(host, { workspace: "big" }, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  const kept = Object.keys(handle.layout.positions);
  assert.equal(kept.length, 400, "fallback must cap the rendered graph at 400 nodes");
  assert.ok(handle.layout.positions.s1, "sources always survive the cut");
  assert.ok(handle.layout.positions.s2, "sources always survive the cut");
  assert.ok(handle.layout.positions.c0, "the highest-degree concept survives the cut");
  // Edges to dropped nodes are filtered, not left dangling.
  for (const e of handle.layout.edges) {
    assert.ok(handle.layout.positions[e.source] && handle.layout.positions[e.target]);
  }
}

async function testWidgetUpdateReloadsOnWorkspaceChange() {
  const host = createFakeHost();
  const client = createClientStub();
  let nthLoad = 0;
  client.runtimeHandler = (path) => {
    nthLoad += 1;
    return jsonResponse({
      nodes: [
        {
          id: `n-${nthLoad}`,
          display_name: `Node ${nthLoad}`,
          aot_layer: 2,
          metrics: { pagerank: 50 }
        }
      ],
      edges: []
    });
  };

  const widget = createSynopticWebWidget(host, { workspace: "first" }, { runtimeClient: client });
  await settle();
  widget.update({ workspace: "second" });
  await settle();

  assert.equal(client.calls.length, 2);
  assert.match(host.innerHTML, /Node 2/);
}

async function testWidgetUpdateRepaintsOnFocusedLayer() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse(SAMPLE_ONTOLOGY);

  const widget = createSynopticWebWidget(host, {}, { runtimeClient: client });
  await settle();
  assert.equal(client.calls.length, 1);

  widget.update({ focusedLayer: 1 });
  await settle();

  // No new fetch — focusedLayer is a render-only change.
  assert.equal(client.calls.length, 1);
  // Node 2 (layer 2) should be faded; node 1 (layer 1) should not.
  assert.match(host.innerHTML, /data-node-id="2"\s+opacity="0.18"/);
}

async function testWidgetCustomRendererReceivesLayout() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse(SAMPLE_ONTOLOGY);

  const renderCalls = [];
  let disposeCalled = 0;
  const customRenderer = {
    mount(_h, layout, props) {
      renderCalls.push({ phase: "mount", layout, props: { ...props } });
      return {
        update(nextLayout, nextProps) {
          renderCalls.push({ phase: "update", layout: nextLayout, props: { ...nextProps } });
        },
        dispose() {
          disposeCalled += 1;
        }
      };
    }
  };

  const widget = createSynopticWebWidget(
    host,
    { workspace: "c4_test" },
    { runtimeClient: client, renderer: customRenderer }
  );
  await settle();

  assert.equal(renderCalls.length, 1);
  assert.equal(renderCalls[0].phase, "mount");
  assert.ok(renderCalls[0].layout.positions["1"]);
  // Default SVG should NOT be rendered when a custom renderer is provided.
  assert.doesNotMatch(host.innerHTML, /<svg /);
  assert.equal(host.dataset.widgetState, "ready");

  // Update with focused layer — should call renderer.update, not remount.
  widget.update({ focusedLayer: 1 });
  await settle();
  assert.equal(renderCalls.length, 2);
  assert.equal(renderCalls[1].phase, "update");
  assert.equal(renderCalls[1].props.focusedLayer, 1);

  widget.destroy();
  assert.equal(disposeCalled, 1);
}

async function testWidgetClickInvokesOnSelect() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse(SAMPLE_ONTOLOGY);

  const clicks = [];
  createSynopticWebWidget(host, { onSelect: (id) => clicks.push(id) }, { runtimeClient: client });
  await settle();

  // Simulate a click on the node group's child.
  const nodeEl = new FakeElement("g", { "data-node-id": "1" });
  const inner = new FakeElement("circle");
  inner.parent = nodeEl;
  host.dispatch("click", { target: inner });

  assert.deepEqual(clicks, ["1"]);
}

async function testWidgetDestroyClearsHostAndDisposesRenderer() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse(SAMPLE_ONTOLOGY);

  const handle = createSynopticWebWidget(host, {}, { runtimeClient: client });
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
