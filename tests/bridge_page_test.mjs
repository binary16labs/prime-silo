#!/usr/bin/env node
//
// Phase B-Bridge — Bridge page pure-helper tests.
//
// bridge.js installs window.bridgePage at import, so we define a minimal
// window before importing (same seam as memory_page_test). We then exercise
// the exported pure helpers (query parsing, mode validation, lifelog icon
// mapping, relative time, run summary) and the mode/chip tables.

import assert from "node:assert/strict";

globalThis.window = globalThis.window || { location: { hash: "" } };

const bridge = await import("../app/L0/_all/mod/_prime_silo/bridge/bridge.js");

async function main() {
  testModesAndChips();
  testReadQuery();
  testIsValidMode();
  testLifelogIcon();
  testRelativeTime();
  testSummariseRuns();
  console.log("bridge_page_test: ok");
}

function testModesAndChips() {
  assert.equal(bridge.MODES.length, 10);
  const ids = bridge.MODES.map((m) => m.id);
  assert.deepEqual(ids, [
    "pulse",
    "memory",
    "documents",
    "code",
    "flows",
    "studio",
    "runs",
    "v2",
    "v3",
    "agents"
  ]);
  // Every mode has chips, and each chip carries an instruction to dispatch.
  for (const id of ids) {
    assert.ok(Array.isArray(bridge.CHIPS[id]) && bridge.CHIPS[id].length > 0, `${id} has chips`);
    for (const chip of bridge.CHIPS[id]) {
      assert.equal(typeof chip.label, "string");
      assert.equal(typeof chip.instruction, "string");
    }
  }
}

function testReadQuery() {
  // readQuery also carries `workspace` (deep-link into a specific workspace).
  assert.deepEqual(bridge.readQuery("#/_prime_silo/bridge?mode=code&id=n1"), {
    mode: "code",
    id: "n1",
    workspace: ""
  });
  assert.deepEqual(bridge.readQuery("#/_prime_silo/bridge?mode=runs&workspace=sessions_v1"), {
    mode: "runs",
    id: "",
    workspace: "sessions_v1"
  });
  assert.deepEqual(bridge.readQuery("#/_prime_silo/bridge"), { mode: "", id: "", workspace: "" });
  assert.deepEqual(bridge.readQuery(""), { mode: "", id: "", workspace: "" });
}

function testIsValidMode() {
  assert.equal(bridge.isValidMode("documents"), true);
  assert.equal(bridge.isValidMode("nope"), false);
  assert.equal(bridge.isValidMode(""), false);
}

function testLifelogIcon() {
  assert.equal(bridge.lifelogIconFor("commit"), "commit");
  assert.equal(bridge.lifelogIconFor("session"), "forum");
  assert.equal(bridge.lifelogIconFor("artifact"), "draft");
  assert.equal(bridge.lifelogIconFor("???"), "circle");
}

function testRelativeTime() {
  const now = 1_000_000_000;
  assert.equal(bridge.relativeTime(now, now), "just now");
  assert.equal(bridge.relativeTime(now - 5 * 60000, now), "5m ago");
  assert.equal(bridge.relativeTime(now - 3 * 3600000, now), "3h ago");
  assert.equal(bridge.relativeTime(0, now), "");
}

function testSummariseRuns() {
  assert.deepEqual(bridge.summariseRuns([]), { total: 0, lastId: "", lastStatus: "" });
  const s = bridge.summariseRuns([
    { run_id: "r1", status: "ok" },
    { run_id: "r0", status: "ok" }
  ]);
  assert.equal(s.total, 2);
  assert.equal(s.lastId, "r1");
  assert.equal(s.lastStatus, "ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
