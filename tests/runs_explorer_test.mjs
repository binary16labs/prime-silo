#!/usr/bin/env node
//
// ADR-001 Phase E expansion — runs_explorer tests.
//
// Two surfaces under test:
//
//   1. The pure mapping helpers in runs-mapping.js.
//      summariseRun, buildRunOverlay, extractManifestSnapshot,
//      sortRunsForDisplay, formatDuration, escapeHtml.
//      No DOM, no fetch, no runtime.
//
//   2. The readRunIdFromQuery utility from runs-explorer.js page entry —
//      exercised via the __testing export. The Alpine x-data factory
//      requires a full browser; we test at the seam that doesn't.
//
// Run:  node tests/runs_explorer_test.mjs

import assert from "node:assert/strict";

import {
  summariseRun,
  buildRunOverlay,
  extractManifestSnapshot,
  sortRunsForDisplay,
  formatDuration,
  escapeHtml
} from "../app/L0/_all/mod/_prime_silo/runs_explorer/runs-mapping.js";

// ---------------------------------------------------------------------------
// Minimal harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// summariseRun
// ---------------------------------------------------------------------------

console.log("\nsummariseRun");

test("returns zeroed object for null input", () => {
  const s = summariseRun(null);
  assert.equal(s.runId, "");
  assert.equal(s.manifestId, "");
  assert.equal(s.status, "");
  assert.equal(s.statusDisplay, "");
  assert.equal(s.nodeStateCount, 0);
  assert.equal(s.errorCount, 0);
  assert.equal(s.durationMs, null);
  assert.equal(s.hasFinalDocument, false);
});

test("returns zeroed object for non-object input", () => {
  const s = summariseRun("bad-input");
  assert.equal(s.runId, "");
});

test("maps all fields from a full RunRecord", () => {
  const record = {
    run_id: "run-abc",
    manifest_id: "mf-123",
    workspace: "ws1",
    status: "completed",
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:01:00Z",
    duration_ms: 60000,
    node_states: { taskA: "completed", taskB: "failed" },
    errors: ["err1"],
    final_document: "some doc text"
  };
  const s = summariseRun(record);
  assert.equal(s.runId, "run-abc");
  assert.equal(s.manifestId, "mf-123");
  assert.equal(s.workspace, "ws1");
  assert.equal(s.status, "completed");
  assert.equal(s.statusDisplay, "Completed");
  assert.equal(s.startedAt, "2026-01-01T00:00:00Z");
  assert.equal(s.completedAt, "2026-01-01T00:01:00Z");
  assert.equal(s.durationMs, 60000);
  assert.equal(s.nodeStateCount, 2);
  assert.equal(s.errorCount, 1);
  assert.equal(s.hasFinalDocument, true);
});

test("statusDisplay falls back to raw status for unknown values", () => {
  const s = summariseRun({ status: "unknown_state" });
  assert.equal(s.statusDisplay, "unknown_state");
});

test("statusDisplay is 'Unknown' for missing status", () => {
  const s = summariseRun({});
  assert.equal(s.statusDisplay, "Unknown");
});

test("hasFinalDocument is false for empty string", () => {
  const s = summariseRun({ final_document: "" });
  assert.equal(s.hasFinalDocument, false);
});

test("nodeStateCount is 0 when node_states is not an object", () => {
  const s = summariseRun({ node_states: null });
  assert.equal(s.nodeStateCount, 0);
});

test("errorCount is 0 when errors is not an array", () => {
  const s = summariseRun({ errors: "not-an-array" });
  assert.equal(s.errorCount, 0);
});

// ---------------------------------------------------------------------------
// buildRunOverlay
// ---------------------------------------------------------------------------

console.log("\nbuildRunOverlay");

test("returns null for null input", () => {
  assert.equal(buildRunOverlay(null), null);
});

test("returns null when node_states is absent", () => {
  assert.equal(buildRunOverlay({}), null);
});

test("returns null for empty node_states", () => {
  assert.equal(buildRunOverlay({ node_states: {} }), null);
});

test("returns overlay with cleaned node_states", () => {
  const record = {
    node_states: { taskA: "completed", taskB: "running", taskC: "failed" }
  };
  const ov = buildRunOverlay(record);
  assert.deepEqual(ov, {
    node_states: { taskA: "completed", taskB: "running", taskC: "failed" }
  });
});

test("drops entries with empty task IDs", () => {
  const record = {
    node_states: { "": "completed", taskA: "completed" }
  };
  const ov = buildRunOverlay(record);
  assert.equal(Object.keys(ov.node_states).length, 1);
  assert.equal(ov.node_states.taskA, "completed");
});

test("drops entries with non-string status values", () => {
  const record = {
    node_states: { taskA: 42, taskB: null, taskC: "completed" }
  };
  const ov = buildRunOverlay(record);
  assert.deepEqual(ov, { node_states: { taskC: "completed" } });
});

test("returns null when all entries are dropped", () => {
  const record = { node_states: { taskA: null, taskB: 99 } };
  assert.equal(buildRunOverlay(record), null);
});

// ---------------------------------------------------------------------------
// extractManifestSnapshot
// ---------------------------------------------------------------------------

console.log("\nextractManifestSnapshot");

test("returns null for null input", () => {
  assert.equal(extractManifestSnapshot(null), null);
});

test("returns null when manifest_snapshot is absent", () => {
  assert.equal(extractManifestSnapshot({}), null);
});

test("returns null when manifest_snapshot has no plan", () => {
  const record = { manifest_snapshot: { name: "foo" } };
  assert.equal(extractManifestSnapshot(record), null);
});

test("returns null when manifest_snapshot.plan is not an object", () => {
  const record = { manifest_snapshot: { plan: "bad" } };
  assert.equal(extractManifestSnapshot(record), null);
});

test("returns snapshot when plan is a valid object", () => {
  const snap = { plan: { waves: [] }, name: "my-manifest" };
  const record = { manifest_snapshot: snap };
  assert.equal(extractManifestSnapshot(record), snap);
});

test("returns null for non-object manifest_snapshot", () => {
  const record = { manifest_snapshot: "string-snap" };
  assert.equal(extractManifestSnapshot(record), null);
});

// ---------------------------------------------------------------------------
// sortRunsForDisplay
// ---------------------------------------------------------------------------

console.log("\nsortRunsForDisplay");

test("returns empty array for non-array input", () => {
  assert.deepEqual(sortRunsForDisplay(null), []);
  assert.deepEqual(sortRunsForDisplay("bad"), []);
});

test("returns empty array for empty input", () => {
  assert.deepEqual(sortRunsForDisplay([]), []);
});

test("active runs float to the top", () => {
  const runs = [
    { run_id: "a", status: "completed", started_at: "2026-01-03" },
    { run_id: "b", status: "running",   started_at: "2026-01-01" },
    { run_id: "c", status: "pending",   started_at: "2026-01-02" }
  ];
  const sorted = sortRunsForDisplay(runs);
  // a (completed) must be last; b and c (active) must be first two
  assert.equal(sorted[sorted.length - 1].run_id, "a");
  const activeIds = sorted.slice(0, 2).map(r => r.run_id).sort();
  assert.deepEqual(activeIds, ["b", "c"]);
});

test("within active bucket newest started_at first", () => {
  const runs = [
    { run_id: "older", status: "running", started_at: "2026-01-01" },
    { run_id: "newer", status: "running", started_at: "2026-01-05" }
  ];
  const sorted = sortRunsForDisplay(runs);
  assert.equal(sorted[0].run_id, "newer");
  assert.equal(sorted[1].run_id, "older");
});

test("within completed bucket newest started_at first", () => {
  const runs = [
    { run_id: "old", status: "completed", started_at: "2026-01-01" },
    { run_id: "new", status: "completed", started_at: "2026-01-10" },
    { run_id: "mid", status: "completed", started_at: "2026-01-05" }
  ];
  const sorted = sortRunsForDisplay(runs);
  assert.equal(sorted[0].run_id, "new");
  assert.equal(sorted[1].run_id, "mid");
  assert.equal(sorted[2].run_id, "old");
});

test("records with missing started_at sort last within their bucket", () => {
  const runs = [
    { run_id: "no-ts",  status: "completed" },
    { run_id: "has-ts", status: "completed", started_at: "2026-01-01" }
  ];
  const sorted = sortRunsForDisplay(runs);
  assert.equal(sorted[0].run_id, "has-ts");
  assert.equal(sorted[1].run_id, "no-ts");
});

test("does not mutate the input array", () => {
  const runs = [
    { run_id: "a", status: "completed" },
    { run_id: "b", status: "running" }
  ];
  const original = runs.slice();
  sortRunsForDisplay(runs);
  assert.deepEqual(runs, original);
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

console.log("\nformatDuration");

test("returns '—' for null", () => { assert.equal(formatDuration(null), "—"); });
test("returns '—' for NaN",  () => { assert.equal(formatDuration(NaN), "—"); });
test("returns '—' for negative", () => { assert.equal(formatDuration(-1), "—"); });
test("returns '—' for Infinity",  () => { assert.equal(formatDuration(Infinity), "—"); });

test("returns ms string for values < 10", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(9), "9ms");
});

test("returns seconds string for 10 ms – 59.9 s", () => {
  assert.equal(formatDuration(1000),  "1.0s");
  assert.equal(formatDuration(12000), "12.0s");
  assert.equal(formatDuration(59500), "59.5s");
});

test("returns minutes+seconds for 1 m – 59 m 59 s", () => {
  assert.equal(formatDuration(60000),   "1m");
  assert.equal(formatDuration(90000),   "1m 30s");
  assert.equal(formatDuration(3599000), "59m 59s");
});

test("returns hours+minutes for >= 1 h", () => {
  assert.equal(formatDuration(3600000), "1h");
  assert.equal(formatDuration(3660000), "1h 1m");
  assert.equal(formatDuration(7200000), "2h");
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

console.log("\nescapeHtml");

test("escapes & < > \" ' in text", () => {
  assert.equal(
    escapeHtml('<a href="x">it\'s &amp;</a>'),
    "&lt;a href=&quot;x&quot;&gt;it&#39;s &amp;amp;&lt;/a&gt;"
  );
});

test("returns empty string for null", () => {
  assert.equal(escapeHtml(null), "");
});

test("returns empty string for undefined", () => {
  assert.equal(escapeHtml(undefined), "");
});

test("does not alter plain text", () => {
  assert.equal(escapeHtml("hello world"), "hello world");
});

// ---------------------------------------------------------------------------
// readRunIdFromQuery — tested via the __testing export
//
// runs-explorer.js calls `window.runsExplorer = ...` at module load time so
// it must be imported *dynamically* after globalThis.window is in place.
// ---------------------------------------------------------------------------

async function testReadRunIdFromQuery() {
  console.log("\nreadRunIdFromQuery");

  // Set up a fake window before the dynamic import evaluates the module.
  // The assignment `window.runsExplorer = ...` at the top of runs-explorer.js
  // needs the global to exist or it throws ReferenceError.
  const prevWindow = globalThis.window;
  globalThis.window = { location: { hash: "" }, runsExplorer: null };

  let mod;
  try {
    mod = await import(
      "../app/L0/_all/mod/_prime_silo/runs_explorer/runs-explorer.js"
    );
  } finally {
    globalThis.window = prevWindow;
  }

  const { readRunIdFromQuery } = mod.__testing;

  // Helper: temporarily override window.location.hash for one assertion.
  function withHash(hash, fn) {
    const prev = globalThis.window;
    globalThis.window = { location: { hash } };
    try { fn(); } finally { globalThis.window = prev; }
  }

  test("returns empty string when there is no hash", () => {
    withHash("", () => assert.equal(readRunIdFromQuery(), ""));
  });

  test("returns empty string when hash has no query string", () => {
    withHash("#/_prime_silo/runs_explorer", () =>
      assert.equal(readRunIdFromQuery(), "")
    );
  });

  test("returns run_id from hash query string", () => {
    withHash("#/_prime_silo/runs_explorer?run_id=run-xyz", () =>
      assert.equal(readRunIdFromQuery(), "run-xyz")
    );
  });

  test("returns empty string when run_id param is absent", () => {
    withHash("#/_prime_silo/runs_explorer?other=foo", () =>
      assert.equal(readRunIdFromQuery(), "")
    );
  });

  test("handles URL-encoded run_id values", () => {
    withHash("#/_prime_silo/runs_explorer?run_id=run%2Fabc", () =>
      assert.equal(readRunIdFromQuery(), "run/abc")
    );
  });

  test("returns empty string when window is undefined", () => {
    const prev = globalThis.window;
    delete globalThis.window;
    try {
      assert.equal(readRunIdFromQuery(), "");
    } finally {
      globalThis.window = prev;
    }
  });
}

// ---------------------------------------------------------------------------
// Run async tests then summarise
// ---------------------------------------------------------------------------

await testReadRunIdFromQuery();

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
