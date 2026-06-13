#!/usr/bin/env node
//
// Phase M1 — memoray.lineage_graph widget tests.
//
// Covers the pure depth-layered layout (BFS depth → x band, robust to
// cycles/orphans), node colour/label helpers, and the factory's
// renderer-injection contract + lifecycle (mount/update/dispose) using a
// stub renderer so no real SVG DOM is needed.

import assert from "node:assert/strict";

import {
  createLineageGraphWidget,
  computeLayout,
  __testing as lg
} from "../app/L0/_all/mod/_prime_silo/widgets/memoray/lineage_graph/index.js";

async function main() {
  testComputeLayoutDepthBands();
  testComputeLayoutHandlesOrphansAndCycles();
  testColorAndLabel();
  await testFactoryRendersViaInjectedRenderer();
  await testFactoryUpdateAndDispose();
  await testFactoryOfflineState();
  console.log("widgets_memoray_lineage_graph_test: ok");
}

const CHAIN = {
  nodes: [
    { id: "sess", type: "Session", label: "Session", timestamp: 1 },
    { id: "u", type: "User Input", label: "ask", timestamp: 2 },
    { id: "t", type: "Tool Call", label: "Write", timestamp: 3 },
    { id: "f", type: "Artifact", label: "out.js", timestamp: 4, metadata: { fileName: "out.js", filePath: "C:/out.js" } }
  ],
  links: [
    { source: "sess", target: "u" },
    { source: "u", target: "t" },
    { source: "t", target: "f" }
  ]
};

function testComputeLayoutDepthBands() {
  const layout = computeLayout(CHAIN.nodes, CHAIN.links);
  assert.equal(layout.positions.sess.depth, 0);
  assert.equal(layout.positions.u.depth, 1);
  assert.equal(layout.positions.t.depth, 2);
  assert.equal(layout.positions.f.depth, 3);
  // x increases with depth.
  assert.ok(layout.positions.f.x > layout.positions.sess.x);
  assert.equal(layout.edges.length, 3);
  assert.ok(layout.width > 0 && layout.height > 0);
}

function testComputeLayoutHandlesOrphansAndCycles() {
  // Orphan node (no links) lands at depth 0; a 2-cycle does not hang.
  const layout = computeLayout(
    [{ id: "a" }, { id: "b" }, { id: "orphan" }],
    [{ source: "a", target: "b" }, { source: "b", target: "a" }]
  );
  assert.ok(layout.positions.a && layout.positions.b && layout.positions.orphan);
  assert.equal(layout.positions.orphan.depth, 0);
  // Links pointing at absent nodes are dropped.
  const dropped = computeLayout([{ id: "x" }], [{ source: "x", target: "ghost" }]);
  assert.equal(dropped.edges.length, 0);
}

function testColorAndLabel() {
  assert.equal(lg.colorFor("Session"), "#c4a882");
  assert.equal(lg.colorFor("Thought"), "#9caf88");
  assert.equal(lg.colorFor("Nonexistent"), "#6b7378");
  assert.equal(lg.nodeLabel({ type: "Artifact", metadata: { fileName: "z.js" } }), "z.js");
  assert.equal(lg.nodeLabel({ label: "explicit" }), "explicit");
}

/* ── stub renderer ───────────────────────────────────────────────────── */

function stubRenderer() {
  const calls = { mount: 0, update: 0, dispose: 0, lastLayout: null };
  return {
    calls,
    mount(host, layout, props) {
      calls.mount += 1;
      calls.lastLayout = layout;
      return {
        update(nextLayout) { calls.update += 1; calls.lastLayout = nextLayout; },
        dispose() { calls.dispose += 1; }
      };
    },
    dispose() { calls.dispose += 1; }
  };
}

function fakeHost() {
  return {
    classList: { add() {}, remove() {} },
    innerHTML: "",
    querySelector: () => null
  };
}

function clientStub(handlers) {
  return {
    memorayFetch: async (path) => ({ _path: path }),
    readMemorayJson: async (resp) => {
      const h = handlers[resp._path];
      if (!h) throw new Error("no handler for " + resp._path);
      const r = h();
      if (r instanceof Error) throw r;
      return r;
    }
  };
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

async function testFactoryRendersViaInjectedRenderer() {
  const renderer = stubRenderer();
  const client = clientStub({ "/graph/sess": () => CHAIN });
  const widget = createLineageGraphWidget(fakeHost(), { sessionId: "sess" }, { renderer, memorayClient: client });
  await settle();
  assert.equal(renderer.calls.mount, 1, "mounts the injected renderer");
  assert.equal(renderer.calls.lastLayout.edges.length, 3);
  assert.ok(widget.layout, "exposes the computed layout");
  widget.destroy();
  assert.ok(renderer.calls.dispose >= 1, "destroy disposes the renderer");
}

async function testFactoryUpdateAndDispose() {
  const renderer = stubRenderer();
  const client = clientStub({
    "/graph/sess": () => CHAIN,
    "/graph/other": () => ({ nodes: [{ id: "o", type: "Session" }], links: [] })
  });
  const widget = createLineageGraphWidget(fakeHost(), { sessionId: "sess" }, { renderer, memorayClient: client });
  await settle();
  const mountsAfterFirst = renderer.calls.mount;
  widget.update({ sessionId: "other" });
  await settle();
  // sessionId change tears down + reloads → another mount on the fresh renderer handle.
  assert.ok(renderer.calls.dispose >= 1);
  assert.ok(renderer.calls.mount >= mountsAfterFirst);
  widget.destroy();
}

async function testFactoryOfflineState() {
  const renderer = stubRenderer();
  const offline = Object.assign(new Error("offline"), { state: "offline" });
  const client = clientStub({ "/graph/sess": () => offline });
  const host = fakeHost();
  const widget = createLineageGraphWidget(host, { sessionId: "sess" }, { renderer, memorayClient: client });
  await settle();
  assert.match(host.innerHTML, /offline/i);
  assert.equal(renderer.calls.mount, 0, "offline path never mounts the graph");
  widget.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
