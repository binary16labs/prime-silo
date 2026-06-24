#!/usr/bin/env node
//
// ADR-001 Phase H — session checkpoint browser module unit tests.
//
// Stubs window.fetch so no real shell or runtime is contacted.
// Covers:
//   checkpoint-compact: size check, under-limit pass-through, over-limit error
//   checkpoint-restore: applyCheckpointRestore (skill errors, missing fileRead),
//                        buildForkName (first fork, Nth fork, name collision),
//                        buildPreRestoreName, buildRestoreNotice
//   checkpoint-client: URL shapes, method, scope header injection, JSON body
//   index.js: saveCheckpoint (schema build, compaction guard),
//             loadCheckpoint, listCheckpoints (drafts + pinned),
//             deleteCheckpoint, forkCheckpoint (name + save)

import assert from "node:assert/strict";

import {
  compactHistoryForCheckpoint,
  estimateHistoryBytes,
  isHistoryWithinCheckpointLimit,
  __testing as compactTesting
} from "../app/L0/_all/mod/_prime_silo/session_checkpoint/checkpoint-compact.js";

import {
  applyCheckpointRestore,
  buildForkName,
  buildPreRestoreName,
  buildRestoreNotice
} from "../app/L0/_all/mod/_prime_silo/session_checkpoint/checkpoint-restore.js";

import {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
  forkCheckpoint
} from "../app/L0/_all/mod/_prime_silo/session_checkpoint/index.js";

import { __testing as rtTesting } from "../app/L0/_all/mod/_prime_silo/runtime_client/runtime-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function installFetchStub(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const callRecord = {
      url: String(url),
      method: (init.method || "GET").toUpperCase(),
      init,
      headers: extractHeaderMap(init.headers),
      body: init.body
    };
    calls.push(callRecord);
    return handler(String(url), init, calls);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

function extractHeaderMap(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out = {};
    headers.forEach((value, name) => {
      out[name.toLowerCase()] = value;
    });
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function makeHistory(messageCount) {
  return Array.from({ length: messageCount }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`
  }));
}

// ---------------------------------------------------------------------------
// compactHistoryForCheckpoint
// ---------------------------------------------------------------------------

async function testCompactPassesThroughSmallHistory() {
  const history = makeHistory(5);
  const result = await compactHistoryForCheckpoint(history, {});
  assert.deepEqual(result, history);
  console.log("  ✓ compactHistoryForCheckpoint passes through small history");
}

async function testCompactReturnsEmptyArrayForNonArray() {
  const result = await compactHistoryForCheckpoint(null, {});
  assert.deepEqual(result, []);
  console.log("  ✓ compactHistoryForCheckpoint returns [] for null input");
}

async function testCompactThrowsForOversizedHistory() {
  const MAX = compactTesting.MAX_CHECKPOINT_BYTES;
  // Build a history whose JSON is just over the limit.
  const bigContent = "x".repeat(MAX);
  const oversized = [{ role: "user", content: bigContent }];
  await assert.rejects(
    () => compactHistoryForCheckpoint(oversized, {}),
    /too large to checkpoint/i
  );
  console.log("  ✓ compactHistoryForCheckpoint throws for oversized history");
}

function testEstimateHistoryBytes() {
  const history = [{ role: "user", content: "hello" }];
  const bytes = estimateHistoryBytes(history);
  assert.ok(bytes > 0);
  assert.ok(bytes < 1024);
  assert.equal(estimateHistoryBytes(null), 0);
  assert.equal(estimateHistoryBytes([]), 2); // "[]" = 2 bytes
  console.log("  ✓ estimateHistoryBytes returns positive value");
}

function testIsHistoryWithinCheckpointLimit() {
  assert.ok(isHistoryWithinCheckpointLimit(makeHistory(10)));
  console.log("  ✓ isHistoryWithinCheckpointLimit returns true for small history");
}

// ---------------------------------------------------------------------------
// applyCheckpointRestore
// ---------------------------------------------------------------------------

async function testApplyCheckpointRestoreReturnsSameHistory() {
  const history = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" }
  ];
  const cp = {
    schema: "aamp.checkpoint/1",
    name: "test",
    workspace: "w",
    saved_at: "2026-05-12T00:00:00Z",
    history,
    skills: [],
    transient_items: {},
    run_refs: [],
    manifest_refs: [],
    metadata: { source: "operator" }
  };
  const result = await applyCheckpointRestore(cp, { spaceApi: {} });
  assert.deepEqual(result.restoredHistory, history);
  assert.deepEqual(result.loadedSkills, []);
  assert.deepEqual(result.warnings, []);
  console.log("  ✓ applyCheckpointRestore returns same history");
}

async function testApplyCheckpointRestoreCollectsSkillErrors() {
  const cp = {
    history: [],
    skills: ["bad-skill"],
    transient_items: {}
  };
  const mockApi = {
    skills: {
      load: async (id) => {
        throw new Error(`skill ${id} not found`);
      }
    }
  };
  const result = await applyCheckpointRestore(cp, { spaceApi: mockApi });
  assert.equal(result.failedSkills.length, 1);
  assert.equal(result.failedSkills[0].skill, "bad-skill");
  assert.ok(result.warnings[0].includes("bad-skill"));
  console.log("  ✓ applyCheckpointRestore collects skill errors as warnings");
}

async function testApplyCheckpointRestoreLoadsSkillsSuccessfully() {
  const loaded = [];
  const cp = {
    history: [{ role: "user", content: "hi" }],
    skills: ["browser-control", "data-analyst"],
    transient_items: {}
  };
  const mockApi = {
    skills: {
      load: async (id) => {
        loaded.push(id);
      }
    }
  };
  const result = await applyCheckpointRestore(cp, { spaceApi: mockApi });
  assert.deepEqual(result.loadedSkills, ["browser-control", "data-analyst"]);
  assert.deepEqual(loaded, ["browser-control", "data-analyst"]);
  assert.deepEqual(result.warnings, []);
  console.log("  ✓ applyCheckpointRestore loads skills successfully");
}

async function testApplyCheckpointRestoreHandlesMissingFileRead() {
  const cp = {
    history: [],
    skills: [],
    transient_items: {
      "file:q3": { path: "~/data/q3.csv", encoding: "utf8" }
    }
  };
  // No fileRead API
  const result = await applyCheckpointRestore(cp, { spaceApi: {} });
  assert.ok(result.restoredTransient["file:q3"]);
  assert.ok(result.warnings.some((w) => w.includes("fileRead API not available")));
  console.log("  ✓ applyCheckpointRestore handles missing fileRead gracefully");
}

// ---------------------------------------------------------------------------
// buildForkName
// ---------------------------------------------------------------------------

function testBuildForkNameFirstFork() {
  const name = buildForkName("analysis-base", []);
  assert.equal(name, "analysis-base_fork_1");
  console.log("  ✓ buildForkName: first fork is _fork_1");
}

function testBuildForkNameIncrements() {
  const existing = [{ name: "analysis-base_fork_1" }, { name: "analysis-base_fork_2" }];
  assert.equal(buildForkName("analysis-base", existing), "analysis-base_fork_3");
  console.log("  ✓ buildForkName: increments past highest existing fork");
}

function testBuildForkNameSkipsGaps() {
  const existing = [
    { name: "x_fork_1" },
    { name: "x_fork_3" } // gap at 2
  ];
  assert.equal(buildForkName("x", existing), "x_fork_4");
  console.log("  ✓ buildForkName: skips gaps and uses max+1");
}

function testBuildForkNameIgnoresUnrelatedCheckpoints() {
  const existing = [{ name: "other-thing_fork_99" }, { name: "analysis-base" }];
  assert.equal(buildForkName("analysis-base", existing), "analysis-base_fork_1");
  console.log("  ✓ buildForkName: ignores unrelated checkpoints");
}

function testBuildPreRestoreName() {
  const name = buildPreRestoreName();
  assert.match(name, /^pre-restore-\d{4}-\d{2}-\d{2}/);
  console.log("  ✓ buildPreRestoreName returns timestamped name");
}

function testBuildRestoreNotice() {
  const notice = buildRestoreNotice("my-checkpoint");
  assert.ok(notice.includes("my-checkpoint"));
  assert.ok(notice.toLowerCase().includes("restored"));
  console.log("  ✓ buildRestoreNotice includes checkpoint name");
}

// ---------------------------------------------------------------------------
// saveCheckpoint — URL shape + schema build
// ---------------------------------------------------------------------------

async function testSaveCheckpointPostsCorrectPayload() {
  rtTesting.resetAgentScope();
  const stub = installFetchStub(async () =>
    jsonResponse({ saved: true, path: "agent_sandbox/checkpoints/my-cp.json", bytes: 200 })
  );
  try {
    const sessionState = {
      history: [{ role: "user", content: "hello" }],
      skills: ["browser-control"],
      transientItems: {},
      runRefs: ["run-abc"],
      manifestRefs: [],
      metadata: { description: "test", source: "operator" }
    };
    const result = await saveCheckpoint("sandbox", "ws", "my-cp", sessionState);
    assert.equal(result.saved, true);

    const call = stub.calls[0];
    assert.equal(call.method, "POST");
    // ADR-003: a sandbox-scoped checkpoint save routes through the agent facade.
    assert.match(call.url, /\/api\/agent-runtime\/agent_sandbox\/checkpoints\/save$/);
    assert.equal(call.headers["x-benny-agent-scope"], "sandbox");
    const body = JSON.parse(call.body);
    assert.equal(body.name, "my-cp");
    assert.equal(body.workspace, "ws");
    assert.equal(body.checkpoint.schema, "aamp.checkpoint/1");
    assert.deepEqual(body.checkpoint.skills, ["browser-control"]);
    assert.deepEqual(body.checkpoint.run_refs, ["run-abc"]);
    assert.equal(body.checkpoint.metadata.source, "operator");
    assert.equal(body.checkpoint.metadata.description, "test");
  } finally {
    stub.restore();
    rtTesting.resetAgentScope();
  }
  console.log("  ✓ saveCheckpoint posts correct payload with schema");
}

async function testSaveCheckpointThrowsForOversizedHistory() {
  const MAX = compactTesting.MAX_CHECKPOINT_BYTES;
  const bigHistory = [{ role: "user", content: "x".repeat(MAX) }];
  await assert.rejects(
    () => saveCheckpoint("sandbox", "ws", "big-cp", { history: bigHistory }),
    /too large to checkpoint/i
  );
  console.log("  ✓ saveCheckpoint throws for oversized history before fetch");
}

// ---------------------------------------------------------------------------
// loadCheckpoint
// ---------------------------------------------------------------------------

async function testLoadCheckpointGetsCorrectUrl() {
  rtTesting.resetAgentScope();
  const cp = { schema: "aamp.checkpoint/1", name: "my-cp", history: [] };
  const stub = installFetchStub(async () => jsonResponse(cp));
  try {
    const result = await loadCheckpoint("sandbox", "my-ws", "my-cp");
    assert.equal(result.schema, "aamp.checkpoint/1");
    assert.match(stub.calls[0].url, /\/agent_sandbox\/checkpoints\/load\/my-ws\/my-cp$/);
    assert.equal(stub.calls[0].method, "GET");
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
  } finally {
    stub.restore();
    rtTesting.resetAgentScope();
  }
  console.log("  ✓ loadCheckpoint GETs correct URL with scope");
}

// ---------------------------------------------------------------------------
// listCheckpoints
// ---------------------------------------------------------------------------

async function testListCheckpointsDraftUrl() {
  rtTesting.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse([]));
  try {
    await listCheckpoints("sandbox", "my-ws");
    assert.match(stub.calls[0].url, /\/agent_sandbox\/checkpoints\/list\/my-ws$/);
  } finally {
    stub.restore();
    rtTesting.resetAgentScope();
  }
  console.log("  ✓ listCheckpoints uses draft URL by default");
}

async function testListCheckpointsPinnedUrl() {
  rtTesting.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse([]));
  try {
    await listCheckpoints("sandbox", "my-ws", { pinned: true });
    assert.match(stub.calls[0].url, /\/checkpoints\/list\/my-ws$/);
    // No scope header on pinned list (bare runtimeFetch)
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], undefined);
  } finally {
    stub.restore();
    rtTesting.resetAgentScope();
  }
  console.log("  ✓ listCheckpoints uses pinned URL when pinned:true and no scope header");
}

// ---------------------------------------------------------------------------
// deleteCheckpoint
// ---------------------------------------------------------------------------

async function testDeleteCheckpointDeletesCorrectUrl() {
  rtTesting.resetAgentScope();
  const stub = installFetchStub(async () =>
    jsonResponse({ deleted: true, name: "my-cp", workspace: "ws", pinned_sibling_exists: false })
  );
  try {
    const result = await deleteCheckpoint("sandbox", "ws", "my-cp");
    assert.equal(result.deleted, true);
    assert.match(stub.calls[0].url, /\/agent_sandbox\/checkpoints\/delete\/ws\/my-cp$/);
    assert.equal(stub.calls[0].method, "DELETE");
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
  } finally {
    stub.restore();
    rtTesting.resetAgentScope();
  }
  console.log("  ✓ deleteCheckpoint sends DELETE to correct URL");
}

async function testDeleteCheckpointForceParam() {
  rtTesting.resetAgentScope();
  const stub = installFetchStub(async () =>
    jsonResponse({ deleted: true, name: "x", workspace: "ws", pinned_sibling_exists: true })
  );
  try {
    await deleteCheckpoint("sandbox", "ws", "x", { force: true });
    assert.match(stub.calls[0].url, /\?force=true$/);
  } finally {
    stub.restore();
    rtTesting.resetAgentScope();
  }
  console.log("  ✓ deleteCheckpoint appends ?force=true when force option is set");
}

// ---------------------------------------------------------------------------
// forkCheckpoint
// ---------------------------------------------------------------------------

async function testForkCheckpointCreatesCorrectForkName() {
  rtTesting.resetAgentScope();
  const originalCp = {
    schema: "aamp.checkpoint/1",
    name: "base",
    workspace: "ws",
    saved_at: "2026-05-12T10:00:00Z",
    history: [{ role: "user", content: "hi" }],
    skills: ["browser-control"],
    transient_items: {},
    run_refs: [],
    manifest_refs: [],
    metadata: { source: "operator", fork_of: null, fork_index: null, description: "" }
  };
  const existingList = [{ name: "base" }]; // no forks yet

  let saveCall = null;
  const stub = installFetchStub(async (url, init) => {
    if (url.includes("/load/")) return jsonResponse(originalCp);
    if (url.includes("/list/")) return jsonResponse(existingList);
    if (url.includes("/save")) {
      saveCall = JSON.parse(init.body || "{}");
      return jsonResponse({
        saved: true,
        path: "agent_sandbox/checkpoints/base_fork_1.json",
        bytes: 1
      });
    }
    return jsonResponse({});
  });
  try {
    const forkName = await forkCheckpoint("sandbox", "ws", "base");
    assert.equal(forkName, "base_fork_1");
    assert.ok(saveCall, "save was called");
    assert.equal(saveCall.name, "base_fork_1");
    assert.equal(saveCall.checkpoint.metadata.fork_of, "base");
    assert.equal(saveCall.checkpoint.metadata.fork_index, 1);
    assert.equal(saveCall.checkpoint.signature, undefined); // stripped
  } finally {
    stub.restore();
    rtTesting.resetAgentScope();
  }
  console.log("  ✓ forkCheckpoint creates fork_1, sets fork metadata, strips signature");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  rtTesting.resetAgentScope();

  console.log("--- checkpoint-compact ---");
  await testCompactPassesThroughSmallHistory();
  await testCompactReturnsEmptyArrayForNonArray();
  await testCompactThrowsForOversizedHistory();
  testEstimateHistoryBytes();
  testIsHistoryWithinCheckpointLimit();

  console.log("--- checkpoint-restore ---");
  await testApplyCheckpointRestoreReturnsSameHistory();
  await testApplyCheckpointRestoreCollectsSkillErrors();
  await testApplyCheckpointRestoreLoadsSkillsSuccessfully();
  await testApplyCheckpointRestoreHandlesMissingFileRead();
  testBuildForkNameFirstFork();
  testBuildForkNameIncrements();
  testBuildForkNameSkipsGaps();
  testBuildForkNameIgnoresUnrelatedCheckpoints();
  testBuildPreRestoreName();
  testBuildRestoreNotice();

  console.log("--- saveCheckpoint ---");
  await testSaveCheckpointPostsCorrectPayload();
  await testSaveCheckpointThrowsForOversizedHistory();

  console.log("--- loadCheckpoint ---");
  await testLoadCheckpointGetsCorrectUrl();

  console.log("--- listCheckpoints ---");
  await testListCheckpointsDraftUrl();
  await testListCheckpointsPinnedUrl();

  console.log("--- deleteCheckpoint ---");
  await testDeleteCheckpointDeletesCorrectUrl();
  await testDeleteCheckpointForceParam();

  console.log("--- forkCheckpoint ---");
  await testForkCheckpointCreatesCorrectForkName();

  console.log("\nsession_checkpoint_test: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
