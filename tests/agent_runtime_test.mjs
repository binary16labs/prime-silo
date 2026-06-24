#!/usr/bin/env node
//
// ADR-001 Phase D2 — agent_runtime module tests.
//
// Verifies the integration seam exposed to space-agent's browser-resident
// agent runtime: mountAgentTurn returns a bound runtime client whose
// shape is widget-compatible (options.runtimeClient), runWithAgentContext
// is a thin alias for withAgentScope, and getCurrentAgentScope reflects
// active state. Also runs the bound client end-to-end against a stubbed
// /widgets call to confirm the chokepoint actually puts the header on
// the wire.

import assert from "node:assert/strict";

import {
  mountAgentTurn,
  runWithAgentContext,
  getCurrentAgentScope,
  __agent_runtime_meta__
} from "../app/L0/_all/mod/_prime_silo/agent_runtime/agent-runtime.js";
import { __testing as runtimeClientTesting } from "../app/L0/_all/mod/_prime_silo/runtime_client/runtime-client.js";

async function main() {
  runtimeClientTesting.resetAgentScope();

  testMountAgentTurnDefaultScope();
  testMountAgentTurnExplicitScopes();
  testMountAgentTurnRejectsBadScope();
  testHandleDisposeIdempotent();
  testRuntimeClientShapeMatchesWidgetExpectations();
  testMetaConstantStable();

  await testBoundClientPutsHeaderOnTheWire();
  await testBoundClientDoesNotMutateModuleScope();
  await testRunWithAgentContextSetsAndRestores();
  await testRunWithAgentContextRestoresAfterReject();
  await testGetCurrentAgentScopeMatchesRuntimeClient();

  console.log("agent_runtime_test: ok");
}

function testMountAgentTurnDefaultScope() {
  const turn = mountAgentTurn();
  try {
    assert.equal(turn.scope, "sandbox", "default scope must match the documented default");
    assert.equal(turn.runtimeClient.scope, "sandbox");
    assert.equal(turn.disposed, false);
  } finally {
    turn.dispose();
  }
}

function testMountAgentTurnExplicitScopes() {
  const sb = mountAgentTurn("sandbox");
  const ro = mountAgentTurn("read_only");
  try {
    assert.equal(sb.scope, "sandbox");
    assert.equal(ro.scope, "read_only");
  } finally {
    sb.dispose();
    ro.dispose();
  }
}

function testMountAgentTurnRejectsBadScope() {
  assert.throws(() => mountAgentTurn("admin"), /Invalid agent scope/);
  assert.throws(() => mountAgentTurn(""), /Invalid agent scope/);
}

function testHandleDisposeIdempotent() {
  const turn = mountAgentTurn("sandbox");
  assert.equal(turn.disposed, false);
  turn.dispose();
  assert.equal(turn.disposed, true);
  // Calling dispose again must not throw.
  turn.dispose();
  assert.equal(turn.disposed, true);
}

function testRuntimeClientShapeMatchesWidgetExpectations() {
  // Widgets accept an options.runtimeClient with these methods. Any
  // future change to the bound-client shape that drops one of these
  // will fail this test before downstream widget tests catch it.
  const turn = mountAgentTurn("sandbox");
  try {
    const c = turn.runtimeClient;
    assert.equal(typeof c.runtimeFetch, "function");
    assert.equal(typeof c.fetchAsAgent, "function");
    assert.equal(typeof c.readRuntimeJson, "function");
    assert.equal(typeof c.listWidgets, "function");
    assert.equal(typeof c.scope, "string");
  } finally {
    turn.dispose();
  }
}

function testMetaConstantStable() {
  // The exported meta is a soft contract for any consumer that wants to
  // introspect the module's intent without importing the runtime.
  assert.equal(typeof __agent_runtime_meta__, "object");
  assert.equal(__agent_runtime_meta__.default_scope, "sandbox");
  assert.equal(typeof __agent_runtime_meta__.schema_version, "string");
}

function installFetchStub(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, headers: extractHeaderMap(init.headers) });
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

async function testBoundClientPutsHeaderOnTheWire() {
  const stub = installFetchStub(async () => jsonResponse([{ id: "kg3d.synoptic_web" }]));
  try {
    const turn = mountAgentTurn("sandbox");
    const widgets = await turn.runtimeClient.listWidgets();
    assert.deepEqual(widgets, [{ id: "kg3d.synoptic_web" }]);
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
    // ADR-003: the bound agent client routes through the agent facade.
    assert.match(stub.calls[0].url, /\/api\/agent-runtime\/widgets$/);
    turn.dispose();
  } finally {
    stub.restore();
  }
}

async function testBoundClientDoesNotMutateModuleScope() {
  runtimeClientTesting.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse({ ok: true }));
  try {
    const turn = mountAgentTurn("sandbox");
    await turn.runtimeClient.runtimeFetch("/widgets");
    // Critical: the bound client tags its OWN calls but does NOT touch
    // the module-level active scope, so unrelated human-driven traffic
    // happening in parallel doesn't inherit the agent scope.
    assert.equal(getCurrentAgentScope(), null);
    turn.dispose();
  } finally {
    stub.restore();
  }
}

async function testRunWithAgentContextSetsAndRestores() {
  runtimeClientTesting.resetAgentScope();
  let observedInside = null;
  await runWithAgentContext("read_only", () => {
    observedInside = getCurrentAgentScope();
  });
  assert.equal(observedInside, "read_only");
  assert.equal(getCurrentAgentScope(), null);
}

async function testRunWithAgentContextRestoresAfterReject() {
  runtimeClientTesting.resetAgentScope();
  await assert.rejects(
    runWithAgentContext("sandbox", async () => {
      assert.equal(getCurrentAgentScope(), "sandbox");
      throw new Error("turn aborted");
    }),
    /turn aborted/
  );
  assert.equal(getCurrentAgentScope(), null);
}

async function testGetCurrentAgentScopeMatchesRuntimeClient() {
  // getCurrentAgentScope is a re-export — assert it's tied to the same
  // state the runtime client reads.
  runtimeClientTesting.resetAgentScope();
  assert.equal(getCurrentAgentScope(), null);
  await runWithAgentContext("sandbox", () => {
    assert.equal(getCurrentAgentScope(), "sandbox");
  });
  assert.equal(getCurrentAgentScope(), null);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
