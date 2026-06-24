#!/usr/bin/env node
//
// ADR-001 Phase C/D — widget registry client tests.
//
// Stubs the global `fetch` so the registry client never depends on a live
// runtime. Exercises caching, refresh, and the agent-authority gate.

import assert from "node:assert/strict";

import {
  loadRegistry,
  getRegistry,
  getWidget,
  isAuthorityAgentSafe,
  __testing as widgetRegistryTesting
} from "../app/L0/_all/mod/_prime_silo/widgets/widget-registry.js";

const SAMPLE_REGISTRY = [
  {
    id: "kg3d.synoptic_web",
    schema_version: "1.0.0",
    title: "Knowledge Graph (3D)",
    description: "Three.js synoptic web of concepts and documents.",
    category: "graph",
    props: {},
    frame_bindings: [{ field: "concepts", required: false }],
    authority: "read_only",
    defaults: {}
  },
  {
    id: "dag.canvas",
    schema_version: "1.0.0",
    title: "DAG Canvas",
    description: "Manifest/Pipeline/Workflow.",
    category: "dag",
    props: {},
    frame_bindings: [],
    authority: "deterministic_only",
    defaults: {}
  },
  {
    id: "text.markdown",
    schema_version: "1.0.0",
    title: "Markdown Note",
    description: "Agent-authored markdown.",
    category: "text",
    props: {},
    frame_bindings: [],
    authority: "read_write_sandbox",
    defaults: {}
  }
];

function installFetchStub(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function main() {
  testAuthorityGate();
  await testLoadAndCache();
  await testRefreshForcesReFetch();
  await testGetRegistryThrowsBeforeLoad();
  await testNonArrayResponseRejected();
  console.log("widget_registry_test: ok");
}

function testAuthorityGate() {
  assert.equal(isAuthorityAgentSafe("read_only"), true);
  assert.equal(isAuthorityAgentSafe("read_write_sandbox"), true);
  assert.equal(isAuthorityAgentSafe("deterministic_only"), false);
  assert.equal(isAuthorityAgentSafe("garbage"), false);
}

async function testLoadAndCache() {
  widgetRegistryTesting.resetCache();
  let calls = 0;
  const restore = installFetchStub(async (url) => {
    calls += 1;
    assert.match(String(url), /\/api\/runtime\/widgets$/);
    return jsonResponse(SAMPLE_REGISTRY);
  });

  try {
    const first = await loadRegistry();
    assert.equal(first.length, 3);

    const second = await loadRegistry();
    assert.equal(second, first, "cached array reused on subsequent load");
    assert.equal(calls, 1, "second load must hit the cache");

    const widget = getWidget("text.markdown");
    assert.ok(widget, "getWidget must resolve a known id");
    assert.equal(widget.authority, "read_write_sandbox");

    assert.equal(getWidget("nope"), undefined);
    assert.equal(getRegistry().length, 3);
  } finally {
    restore();
  }
}

async function testRefreshForcesReFetch() {
  widgetRegistryTesting.resetCache();
  let calls = 0;
  const restore = installFetchStub(async () => {
    calls += 1;
    return jsonResponse(SAMPLE_REGISTRY);
  });

  try {
    await loadRegistry();
    await loadRegistry({ refresh: true });
    assert.equal(calls, 2, "refresh:true must bypass cache");
  } finally {
    restore();
  }
}

async function testGetRegistryThrowsBeforeLoad() {
  widgetRegistryTesting.resetCache();
  assert.throws(() => getRegistry(), /not loaded/i);
}

async function testNonArrayResponseRejected() {
  widgetRegistryTesting.resetCache();
  const restore = installFetchStub(async () => jsonResponse({ unexpected: "shape" }));

  try {
    await assert.rejects(loadRegistry(), /not an array/i);
  } finally {
    restore();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
