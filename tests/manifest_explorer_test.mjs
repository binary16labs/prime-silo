#!/usr/bin/env node
//
// ADR-001 Phase E — manifest_explorer tests.
//
// Two surfaces under test:
//
//   1. The pure SwarmManifest → dag-data mapping in manifest-mapping.js.
//      Heavy lifting lives here — wave-index inversion, run overlay,
//      defensive shape handling. No DOM, no fetch.
//
//   2. The page entry in manifest-explorer.js — exercised at the level of
//      its purely-functional helpers (`__testing.readManifestIdFromQuery`).
//      The Alpine x-data factory itself is wired into the DOM via Alpine
//      and would need a full browser to drive end-to-end; we accept that
//      gap and check the seams that don't need a host.

import assert from "node:assert/strict";

import {
  mapManifestToDagData,
  summariseManifest
} from "../app/L0/_all/mod/_prime_silo/manifest_explorer/manifest-mapping.js";

async function main() {
  testMapManifestRequiresObject();
  testMapManifestEmptyPlanProducesEmptyData();
  testMapManifestExtractsTasksAndEdges();
  testMapManifestUsesLabelOrNameOrId();
  testMapManifestStatusFallbackChain();
  testMapManifestWaveIndexInversion();
  testMapManifestWaveIndexUsesLowestWhenDuplicated();
  testMapManifestRunOverlayBeatsTaskStatus();
  testMapManifestSkipsTasksWithoutId();
  testMapManifestSkipsEdgesWithMissingEnds();
  testMapManifestPropagatesEdgeLabels();

  testSummariseManifestEmptyEnvelope();
  testSummariseManifestCounts();

  await testReadManifestIdFromHashQuery();

  console.log("manifest_explorer_test: ok");
}

// ---------------------------------------------------------------------------
// mapManifestToDagData
// ---------------------------------------------------------------------------

function testMapManifestRequiresObject() {
  assert.throws(() => mapManifestToDagData(null), /must be an object/);
  assert.throws(() => mapManifestToDagData("nope"), /must be an object/);
}

function testMapManifestEmptyPlanProducesEmptyData() {
  const out = mapManifestToDagData({ id: "m1", plan: {} });
  assert.deepEqual(out, { nodes: [], edges: [] });
}

function testMapManifestExtractsTasksAndEdges() {
  const out = mapManifestToDagData({
    id: "m1",
    plan: {
      tasks: [
        { id: "ingest", label: "Ingest trades", status: "completed" },
        { id: "score",  label: "Score risk",    status: "running"   }
      ],
      edges: [{ source: "ingest", target: "score" }],
      waves: [["ingest"], ["score"]]
    }
  });
  assert.deepEqual(out.nodes, [
    { id: "ingest", label: "Ingest trades", status: "completed", wave: 0 },
    { id: "score",  label: "Score risk",    status: "running",   wave: 1 }
  ]);
  assert.deepEqual(out.edges, [{ source: "ingest", target: "score" }]);
}

function testMapManifestUsesLabelOrNameOrId() {
  const out = mapManifestToDagData({
    plan: {
      tasks: [
        { id: "a", label: "Label A" },           // label wins
        { id: "b", name: "Name B" },             // name wins when label missing
        { id: "c" }                              // id is the fallback
      ]
    }
  });
  assert.equal(out.nodes[0].label, "Label A");
  assert.equal(out.nodes[1].label, "Name B");
  assert.equal(out.nodes[2].label, "c");
}

function testMapManifestStatusFallbackChain() {
  const out = mapManifestToDagData({
    plan: {
      tasks: [
        { id: "a", status: "failed" },           // task status wins
        { id: "b" }                              // pending fallback
      ]
    }
  });
  assert.equal(out.nodes[0].status, "failed");
  assert.equal(out.nodes[1].status, "pending");
}

function testMapManifestWaveIndexInversion() {
  const out = mapManifestToDagData({
    plan: {
      tasks: [
        { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }
      ],
      waves: [["a"], ["b", "c"], ["d"]]
    }
  });
  const byId = Object.fromEntries(out.nodes.map((n) => [n.id, n.wave]));
  assert.deepEqual(byId, { a: 0, b: 1, c: 1, d: 2 });
}

function testMapManifestWaveIndexUsesLowestWhenDuplicated() {
  // A defensive case — a task should not appear in two waves, but if a
  // malformed manifest does that, we take the lowest so the longest-path
  // layout still works as a floor (matches dag.canvas semantics).
  const out = mapManifestToDagData({
    plan: {
      tasks: [{ id: "a" }],
      waves: [["a"], ["a"]]
    }
  });
  assert.equal(out.nodes[0].wave, 0);
}

function testMapManifestRunOverlayBeatsTaskStatus() {
  const out = mapManifestToDagData(
    {
      plan: {
        tasks: [
          { id: "a", status: "pending" },
          { id: "b", status: "completed" }
        ]
      }
    },
    {
      runOverlay: { node_states: { a: "running", b: "failed" } }
    }
  );
  assert.equal(out.nodes[0].status, "running");
  assert.equal(out.nodes[1].status, "failed");
}

function testMapManifestSkipsTasksWithoutId() {
  const out = mapManifestToDagData({
    plan: {
      tasks: [
        { id: "ok" },
        { label: "no id" },          // dropped
        { id: "" }                   // dropped
      ]
    }
  });
  assert.equal(out.nodes.length, 1);
  assert.equal(out.nodes[0].id, "ok");
}

function testMapManifestSkipsEdgesWithMissingEnds() {
  const out = mapManifestToDagData({
    plan: {
      edges: [
        { source: "a", target: "b" },
        { source: "a" },               // dropped
        { target: "b" },               // dropped
        { source: 1, target: "b" }     // dropped (non-string)
      ]
    }
  });
  assert.deepEqual(out.edges, [{ source: "a", target: "b" }]);
}

function testMapManifestPropagatesEdgeLabels() {
  const out = mapManifestToDagData({
    plan: {
      edges: [
        { source: "a", target: "b", label: "feeds" },
        { source: "b", target: "c", label: "" }    // empty label dropped
      ]
    }
  });
  assert.equal(out.edges[0].label, "feeds");
  assert.equal("label" in out.edges[1], false);
}

// ---------------------------------------------------------------------------
// summariseManifest
// ---------------------------------------------------------------------------

function testSummariseManifestEmptyEnvelope() {
  assert.deepEqual(summariseManifest(null), {
    id: "", requirement: "", taskCount: 0, edgeCount: 0, waveCount: 0
  });
}

function testSummariseManifestCounts() {
  const out = summariseManifest({
    id: "m1",
    requirement: "Score risk for Q3 trades",
    plan: {
      tasks: [{ id: "a" }, { id: "b" }],
      edges: [{ source: "a", target: "b" }],
      waves: [["a"], ["b"]]
    }
  });
  assert.deepEqual(out, {
    id: "m1",
    requirement: "Score risk for Q3 trades",
    taskCount: 2,
    edgeCount: 1,
    waveCount: 2
  });
}

// ---------------------------------------------------------------------------
// readManifestIdFromQuery — tested via the __testing export
// ---------------------------------------------------------------------------

async function testReadManifestIdFromHashQuery() {
  // Stub the module's window before import. We dynamically import the page
  // entry so we can manipulate globalThis.window first.
  const fakeWindow = {
    location: { hash: "#/_prime_silo/manifest_explorer?manifest_id=m42" }
  };
  const previousWindow = globalThis.window;
  globalThis.window = fakeWindow;

  // The page entry calls `window.manifestExplorer = ...` at top level — that
  // would error in node without a window object. Stash a sink and discard.
  fakeWindow.manifestExplorer = null;

  // Stub the dag.canvas + runtime-client imports the page entry pulls in,
  // so the import itself doesn't blow up under node. The bare-fetch entry
  // doesn't run until init() is invoked, but the imports execute eagerly.
  // Easier path: re-implement the helper inline and test it by behaviour.
  // We assert the exported helper handles the hash-query parsing correctly.

  // Restore window before doing the dynamic import — the entry file uses
  // window.location at MODULE LOAD time inside a try/catch via the helper,
  // so it's safe either way.
  try {
    const mod = await import(
      "../app/L0/_all/mod/_prime_silo/manifest_explorer/manifest-explorer.js"
    );
    // Direct call.
    fakeWindow.location.hash = "#/_prime_silo/manifest_explorer?manifest_id=m42";
    assert.equal(mod.__testing.readManifestIdFromQuery(), "m42");

    fakeWindow.location.hash = "#/_prime_silo/manifest_explorer";
    assert.equal(mod.__testing.readManifestIdFromQuery(), "");

    fakeWindow.location.hash = "#/_prime_silo/manifest_explorer?other=x&manifest_id=m99";
    assert.equal(mod.__testing.readManifestIdFromQuery(), "m99");

    fakeWindow.location.hash = "";
    assert.equal(mod.__testing.readManifestIdFromQuery(), "");
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
