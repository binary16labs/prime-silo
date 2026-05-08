#!/usr/bin/env node
//
// ADR-001 Phase D2 — agent-scope injection tests for runtime-client.js.
//
// Stubs window.fetch so the tests never touch a real shell or runtime.
// Verifies: scope validation, the bound-client factory tags every call,
// withAgentScope auto-injects on the unbound runtimeFetch, explicit
// headers win, scope nesting restores correctly, async withAgentScope
// restores after rejection, and pre-existing helpers (fetchAsAgent,
// listWidgets) keep working untouched.

import assert from "node:assert/strict";

import {
  runtimeFetch,
  fetchAsAgent,
  listWidgets,
  readRuntimeJson,
  createAgentRuntimeClient,
  withAgentScope,
  getActiveAgentScope,
  __testing
} from "../app/L0/_all/mod/_prime_silo/runtime_client/runtime-client.js";

async function main() {
  __testing.resetAgentScope();

  testScopeValidation();
  testGetActiveAgentScopeStartsNull();
  testWithAgentScopeRejectsBadInputs();

  await testRuntimeFetchUnscopedHasNoHeader();
  await testWithAgentScopeAutoInjectsHeader();
  await testWithAgentScopeRestoresAfterReturn();
  await testWithAgentScopeRestoresAfterAsyncReject();
  await testWithAgentScopeNestingShadowsAndRestores();
  await testExplicitHeaderWinsOverActiveScope();

  await testCreateAgentRuntimeClientTagsAllCalls();
  await testCreateAgentRuntimeClientReadOnlyScope();
  await testCreateAgentRuntimeClientFetchAsAgentOverride();
  await testCreateAgentRuntimeClientListWidgetsParsesJson();

  await testFetchAsAgentInjectsHeader();
  await testListWidgetsUnscopedStillWorks();

  await testNon2xxRaisesRuntimeError();

  console.log("runtime_client_agent_scope_test: ok");
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
    headers.forEach((value, name) => { out[name.toLowerCase()] = value; });
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

function testScopeValidation() {
  // Bound client rejects bad scope synchronously.
  assert.throws(() => createAgentRuntimeClient("admin"), /Invalid agent scope/);
  assert.throws(() => createAgentRuntimeClient(""), /Invalid agent scope/);
  assert.throws(() => createAgentRuntimeClient(undefined), /Invalid agent scope/);
  // Both valid scopes accepted.
  const sandbox = createAgentRuntimeClient("sandbox");
  const readOnly = createAgentRuntimeClient("read_only");
  assert.equal(sandbox.scope, "sandbox");
  assert.equal(readOnly.scope, "read_only");
}

function testGetActiveAgentScopeStartsNull() {
  __testing.resetAgentScope();
  assert.equal(getActiveAgentScope(), null);
}

function testWithAgentScopeRejectsBadInputs() {
  assert.throws(() => withAgentScope("nope", () => 1), /Invalid agent scope/);
  assert.throws(() => withAgentScope("sandbox", "not a function"), /must be a function/);
}

async function testRuntimeFetchUnscopedHasNoHeader() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse({ ok: true }));
  try {
    await runtimeFetch("/widgets");
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], undefined);
    assert.match(stub.calls[0].url, /\/api\/runtime\/widgets$/);
  } finally {
    stub.restore();
  }
}

async function testWithAgentScopeAutoInjectsHeader() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse({ ok: true }));
  try {
    await withAgentScope("sandbox", () => runtimeFetch("/widgets"));
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
  } finally {
    stub.restore();
  }
  // Scope is gone after the block.
  assert.equal(getActiveAgentScope(), null);
}

async function testWithAgentScopeRestoresAfterReturn() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse({ ok: true }));
  try {
    await withAgentScope("read_only", async () => {
      assert.equal(getActiveAgentScope(), "read_only");
      await runtimeFetch("/widgets");
    });
    assert.equal(getActiveAgentScope(), null);
  } finally {
    stub.restore();
  }
}

async function testWithAgentScopeRestoresAfterAsyncReject() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse({ ok: true }));
  try {
    await assert.rejects(
      withAgentScope("sandbox", async () => {
        assert.equal(getActiveAgentScope(), "sandbox");
        throw new Error("agent boom");
      }),
      /agent boom/
    );
    // Critically: scope restored even though fn() rejected.
    assert.equal(getActiveAgentScope(), null);
  } finally {
    stub.restore();
  }
}

async function testWithAgentScopeNestingShadowsAndRestores() {
  __testing.resetAgentScope();
  const observed = [];
  const stub = installFetchStub(async (_url, init) => {
    observed.push(extractHeaderMap(init.headers)["x-benny-agent-scope"] || null);
    return jsonResponse({ ok: true });
  });
  try {
    await withAgentScope("sandbox", async () => {
      await runtimeFetch("/a");
      await withAgentScope("read_only", async () => {
        await runtimeFetch("/b");
      });
      // Outer scope restored after inner block.
      await runtimeFetch("/c");
    });
    assert.deepEqual(observed, ["sandbox", "read_only", "sandbox"]);
    assert.equal(getActiveAgentScope(), null);
  } finally {
    stub.restore();
  }
}

async function testExplicitHeaderWinsOverActiveScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse({ ok: true }));
  try {
    await withAgentScope("sandbox", () =>
      runtimeFetch("/widgets", { headers: { "X-Benny-Agent-Scope": "read_only" } })
    );
    // Caller's explicit header is preserved — ambient context does not
    // override an intentional value.
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "read_only");
  } finally {
    stub.restore();
  }
}

async function testCreateAgentRuntimeClientTagsAllCalls() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse({ ok: true }));
  try {
    const client = createAgentRuntimeClient("sandbox");
    await client.runtimeFetch("/agent_sandbox/health");
    await client.fetchAsAgent("/agent_sandbox/write", { method: "POST" });
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
    assert.equal(stub.calls[1].headers["x-benny-agent-scope"], "sandbox");
    // Bound client must NOT pollute the module-level active scope.
    assert.equal(getActiveAgentScope(), null);
  } finally {
    stub.restore();
  }
}

async function testCreateAgentRuntimeClientReadOnlyScope() {
  const stub = installFetchStub(async () => jsonResponse({ ok: true }));
  try {
    const client = createAgentRuntimeClient("read_only");
    await client.runtimeFetch("/widgets");
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "read_only");
  } finally {
    stub.restore();
  }
}

async function testCreateAgentRuntimeClientFetchAsAgentOverride() {
  // The client was created with "sandbox", but fetchAsAgent allows the
  // caller to escalate to a different valid scope per call.
  const stub = installFetchStub(async () => jsonResponse({ ok: true }));
  try {
    const client = createAgentRuntimeClient("sandbox");
    await client.fetchAsAgent("/widgets", {}, { scope: "read_only" });
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "read_only");
  } finally {
    stub.restore();
  }
}

async function testCreateAgentRuntimeClientListWidgetsParsesJson() {
  const stub = installFetchStub(async () => jsonResponse([{ id: "text.markdown" }]));
  try {
    const client = createAgentRuntimeClient("sandbox");
    const widgets = await client.listWidgets();
    assert.deepEqual(widgets, [{ id: "text.markdown" }]);
    assert.match(stub.calls[0].url, /\/api\/runtime\/widgets$/);
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
  } finally {
    stub.restore();
  }
}

async function testFetchAsAgentInjectsHeader() {
  // Existing fetchAsAgent contract — kept intact by Phase D2.
  const stub = installFetchStub(async () => jsonResponse({ ok: true }));
  try {
    await fetchAsAgent("/widgets");
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
  } finally {
    stub.restore();
  }
}

async function testListWidgetsUnscopedStillWorks() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse([{ id: "x" }]));
  try {
    const widgets = await listWidgets();
    assert.deepEqual(widgets, [{ id: "x" }]);
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], undefined);
  } finally {
    stub.restore();
  }
}

async function testNon2xxRaisesRuntimeError() {
  const stub = installFetchStub(async () =>
    new Response(JSON.stringify({ detail: "agent write outside sandbox" }), {
      status: 403,
      headers: { "content-type": "application/json" }
    })
  );
  try {
    let raised = null;
    try {
      await runtimeFetch("/agent_sandbox/write");
    } catch (err) {
      raised = err;
    }
    assert.ok(raised, "expected RuntimeError to be thrown");
    assert.equal(raised.name, "RuntimeError");
    assert.equal(raised.status, 403);
    assert.match(raised.message, /agent write outside sandbox/);
  } finally {
    stub.restore();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
