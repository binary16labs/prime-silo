#!/usr/bin/env node
//
// ADR-001 Phase F2b — loadPinnedView helper on runtime-client.js.
//
// Stubs window.fetch so the tests never touch a real shell or runtime.
// Verifies:
//   • loadPinnedView GETs the correct path with workspace/filename encoded
//   • the runtime envelope is returned verbatim
//   • required-input validation rejects empty workspace/filename
//   • the bound-client variant tags the scope header (reads are NOT 403'd
//     by the runtime — agents may replay pinned views — but the header
//     still rides along so audit logs record the actor)
//   • bound-client invocations don't leak the scope past the call

import assert from "node:assert/strict";

import {
  loadPinnedView,
  createAgentRuntimeClient,
  getActiveAgentScope,
  __testing
} from "../app/L0/_all/mod/_prime_silo/runtime_client/runtime-client.js";

async function main() {
  __testing.resetAgentScope();

  await testLoadPinnedViewGetsCorrectPath();
  await testLoadPinnedViewEncodesPathSegments();
  await testLoadPinnedViewReturnsRuntimeEnvelope();
  await testLoadPinnedViewSurfacesValidFalse();
  await testLoadPinnedViewSurfacesMissingSignature();
  await testLoadPinnedViewRequiresWorkspace();
  await testLoadPinnedViewRequiresFilename();
  await testLoadPinnedViewSurfaces404AsRuntimeError();
  await testLoadPinnedViewSurfaces400AsRuntimeError();

  await testBoundClientLoadPinnedViewTagsScope();
  await testBoundClientLoadPinnedViewDoesNotLeakScope();

  console.log("runtime_client_load_pinned_view_test: ok");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function installFetchStub(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: (init.method || "GET").toUpperCase(),
      init,
      headers: extractHeaderMap(init.headers),
      body: init.body
    });
    return handler(String(url), init, calls);
  };
  return {
    calls,
    restore() { globalThis.fetch = original; }
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

function loadValidEnvelope() {
  const signature = {
    algorithm: "HMAC-SHA256",
    value: "ab".repeat(32),
    signed_at: "2026-05-08T00:00:00+00:00"
  };
  return {
    workspace: "c5_test",
    filename: "compose.aamp.view",
    relative_path: "views/compose.aamp.view",
    bytes: 256,
    view: {
      schema: "aamp.view/1",
      panels: [{ widget: "text.markdown" }],
      signature
    },
    signature,
    valid: true
  };
}

// ---------------------------------------------------------------------------
// Wire-shape
// ---------------------------------------------------------------------------

async function testLoadPinnedViewGetsCorrectPath() {
  const stub = installFetchStub(async () => jsonResponse(loadValidEnvelope()));
  try {
    await loadPinnedView("c5_test", "compose.aamp.view");
    const call = stub.calls[0];
    assert.equal(call.method, "GET");
    assert.match(call.url, /\/api\/runtime\/views\/load\/c5_test\/compose\.aamp\.view$/);
    // GET has no request body.
    assert.equal(call.body, undefined);
  } finally {
    stub.restore();
  }
}

async function testLoadPinnedViewEncodesPathSegments() {
  // Defensive: filenames with characters that need URL-encoding still produce
  // a valid request. (The server-side validator rejects path separators
  // regardless, but the helper must not crash on encoding.)
  const stub = installFetchStub(async () => jsonResponse(loadValidEnvelope()));
  try {
    await loadPinnedView("a b", "file with spaces.aamp.view");
    const call = stub.calls[0];
    assert.match(call.url, /\/api\/runtime\/views\/load\/a%20b\/file%20with%20spaces\.aamp\.view$/);
  } finally {
    stub.restore();
  }
}

async function testLoadPinnedViewReturnsRuntimeEnvelope() {
  const envelope = loadValidEnvelope();
  const stub = installFetchStub(async () => jsonResponse(envelope));
  try {
    const out = await loadPinnedView("c5_test", "compose.aamp.view");
    assert.deepEqual(out, envelope);
  } finally {
    stub.restore();
  }
}

async function testLoadPinnedViewSurfacesValidFalse() {
  // valid=false is NOT an HTTP error — it's a runtime-level integrity
  // signal that the helper must pass through unchanged so the caller can
  // branch on it.
  const tampered = {
    ...loadValidEnvelope(),
    valid: false
  };
  const stub = installFetchStub(async () => jsonResponse(tampered));
  try {
    const out = await loadPinnedView("c5_test", "compose.aamp.view");
    assert.equal(out.valid, false);
    assert.notEqual(out.signature, null);
  } finally {
    stub.restore();
  }
}

async function testLoadPinnedViewSurfacesMissingSignature() {
  const noSig = {
    workspace: "c5_test",
    filename: "unsigned.aamp.view",
    relative_path: "views/unsigned.aamp.view",
    bytes: 64,
    view: { schema: "aamp.view/1", panels: [] },
    signature: null,
    valid: false
  };
  const stub = installFetchStub(async () => jsonResponse(noSig));
  try {
    const out = await loadPinnedView("c5_test", "unsigned.aamp.view");
    assert.equal(out.signature, null);
    assert.equal(out.valid, false);
  } finally {
    stub.restore();
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

async function testLoadPinnedViewRequiresWorkspace() {
  await assert.rejects(() => loadPinnedView("", "compose.aamp.view"), /workspace is required/);
  await assert.rejects(() => loadPinnedView(null, "compose.aamp.view"), /workspace is required/);
}

async function testLoadPinnedViewRequiresFilename() {
  await assert.rejects(() => loadPinnedView("c5_test", ""), /filename is required/);
  await assert.rejects(() => loadPinnedView("c5_test", null), /filename is required/);
}

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

async function testLoadPinnedViewSurfaces404AsRuntimeError() {
  const stub = installFetchStub(async () =>
    new Response(
      JSON.stringify({ detail: "views/nope.aamp.view does not exist in workspace 'c5_test'." }),
      { status: 404, headers: { "content-type": "application/json" } }
    )
  );
  try {
    let raised = null;
    try {
      await loadPinnedView("c5_test", "nope.aamp.view");
    } catch (err) {
      raised = err;
    }
    assert.ok(raised, "expected RuntimeError");
    assert.equal(raised.name, "RuntimeError");
    assert.equal(raised.status, 404);
    assert.match(raised.message, /does not exist/);
  } finally {
    stub.restore();
  }
}

async function testLoadPinnedViewSurfaces400AsRuntimeError() {
  // 400 fires for "not JSON" / "not an object" / "bad filename". The helper
  // surfaces them all uniformly as RuntimeError(status=400) — the message
  // is the runtime's, not synthesised.
  const stub = installFetchStub(async () =>
    new Response(
      JSON.stringify({ detail: "Pinned view is not valid JSON: Expecting value" }),
      { status: 400, headers: { "content-type": "application/json" } }
    )
  );
  try {
    let raised = null;
    try {
      await loadPinnedView("c5_test", "broken.aamp.view");
    } catch (err) {
      raised = err;
    }
    assert.ok(raised, "expected RuntimeError");
    assert.equal(raised.status, 400);
    assert.match(raised.message, /not valid JSON/);
  } finally {
    stub.restore();
  }
}

// ---------------------------------------------------------------------------
// Bound client
// ---------------------------------------------------------------------------

async function testBoundClientLoadPinnedViewTagsScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse(loadValidEnvelope()));
  try {
    const client = createAgentRuntimeClient("sandbox");
    await client.loadPinnedView("c5_test", "compose.aamp.view");
    // Reads are not 403'd by AgentScopeMiddleware — agents can replay
    // pinned views — but the scope header still rides along so the audit
    // log records the actor. The bound client must not silently strip it.
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
  } finally {
    stub.restore();
  }
}

async function testBoundClientLoadPinnedViewDoesNotLeakScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse(loadValidEnvelope()));
  try {
    const client = createAgentRuntimeClient("read_only");
    await client.loadPinnedView("c5_test", "compose.aamp.view");
    assert.equal(getActiveAgentScope(), null);
  } finally {
    stub.restore();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
