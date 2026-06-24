#!/usr/bin/env node
//
// ADR-001 Phase F — view-signing helpers on runtime-client.js.
//
// Stubs window.fetch so the tests never touch a real shell or runtime.
// Verifies: signView posts the right payload, verifyView posts and unwraps
// the boolean, both helpers reject non-object input, and the bound agent
// client *forwards* its scope header (so the runtime's AgentScopeMiddleware
// can issue the intended 403 — the boundary is enforced server-side, not
// silently downgraded here).

import assert from "node:assert/strict";

import {
  signView,
  verifyView,
  createAgentRuntimeClient,
  getActiveAgentScope,
  __testing
} from "../app/L0/_all/mod/_prime_silo/runtime_client/runtime-client.js";

async function main() {
  __testing.resetAgentScope();

  await testSignViewPostsCanonicalPayload();
  await testSignViewRejectsNonObjectInput();
  await testSignViewSurfaces403AsRuntimeError();

  await testVerifyViewPostsViewAndSignature();
  await testVerifyViewReturnsTrueForValid();
  await testVerifyViewReturnsFalseForInvalid();
  await testVerifyViewHandlesMissingValidField();
  await testVerifyViewRejectsNonObjectInput();

  await testBoundClientSignViewTagsScope();
  await testBoundClientVerifyViewTagsScope();
  await testBoundClientDoesNotLeakScope();

  console.log("runtime_client_view_signing_test: ok");
}

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

async function testSignViewPostsCanonicalPayload() {
  const stub = installFetchStub(async () =>
    jsonResponse({
      signature: {
        algorithm: "HMAC-SHA256",
        value: "deadbeef".repeat(8),
        signed_at: "2026-05-08T00:00:00+00:00"
      },
      canonical_payload: '{"panels":[],"schema":"aamp.view/1"}'
    })
  );
  try {
    const view = { schema: "aamp.view/1", panels: [] };
    const out = await signView(view);
    const call = stub.calls[0];
    assert.equal(call.method, "POST");
    assert.match(call.url, /\/api\/runtime\/views\/sign$/);
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(call.body), { view });
    assert.equal(out.signature.algorithm, "HMAC-SHA256");
    assert.equal(out.canonical_payload, '{"panels":[],"schema":"aamp.view/1"}');
  } finally {
    stub.restore();
  }
}

async function testSignViewRejectsNonObjectInput() {
  await assert.rejects(() => signView(null), /must be a JSON object/);
  await assert.rejects(() => signView("not an object"), /must be a JSON object/);
  await assert.rejects(() => signView([1, 2, 3]), /must be a JSON object/);
}

async function testSignViewSurfaces403AsRuntimeError() {
  const stub = installFetchStub(
    async () =>
      new Response(
        JSON.stringify({
          detail: "Forbidden: Agent scope 'sandbox' may only write under /api/agent_sandbox/."
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      )
  );
  try {
    let raised = null;
    try {
      await signView({ schema: "aamp.view/1", panels: [] });
    } catch (err) {
      raised = err;
    }
    assert.ok(raised, "expected RuntimeError");
    assert.equal(raised.name, "RuntimeError");
    assert.equal(raised.status, 403);
    assert.match(raised.message, /agent_sandbox/);
  } finally {
    stub.restore();
  }
}

async function testVerifyViewPostsViewAndSignature() {
  const stub = installFetchStub(async () => jsonResponse({ valid: true }));
  try {
    const view = { schema: "aamp.view/1", panels: [] };
    const sig = { algorithm: "HMAC-SHA256", value: "abc", signed_at: "2026-05-08T00:00:00+00:00" };
    await verifyView(view, sig);
    const call = stub.calls[0];
    assert.equal(call.method, "POST");
    assert.match(call.url, /\/api\/runtime\/views\/verify$/);
    assert.deepEqual(JSON.parse(call.body), { view, signature: sig });
  } finally {
    stub.restore();
  }
}

async function testVerifyViewReturnsTrueForValid() {
  const stub = installFetchStub(async () => jsonResponse({ valid: true }));
  try {
    const ok = await verifyView({ a: 1 }, { algorithm: "HMAC-SHA256", value: "x", signed_at: "z" });
    assert.equal(ok, true);
  } finally {
    stub.restore();
  }
}

async function testVerifyViewReturnsFalseForInvalid() {
  const stub = installFetchStub(async () => jsonResponse({ valid: false }));
  try {
    const ok = await verifyView({ a: 1 }, { algorithm: "HMAC-SHA256", value: "x", signed_at: "z" });
    assert.equal(ok, false);
  } finally {
    stub.restore();
  }
}

async function testVerifyViewHandlesMissingValidField() {
  // A defensive default — if the runtime ever returns a malformed envelope,
  // the helper should treat it as "not verified" rather than truthy.
  const stub = installFetchStub(async () => jsonResponse({ unrelated: true }));
  try {
    const ok = await verifyView({ a: 1 }, { algorithm: "HMAC-SHA256", value: "x", signed_at: "z" });
    assert.equal(ok, false);
  } finally {
    stub.restore();
  }
}

async function testVerifyViewRejectsNonObjectInput() {
  const sig = { algorithm: "HMAC-SHA256", value: "x", signed_at: "z" };
  await assert.rejects(() => verifyView(null, sig), /view must be a JSON object/);
  await assert.rejects(() => verifyView({ a: 1 }, null), /signature must be an envelope/);
  await assert.rejects(() => verifyView([1], sig), /view must be a JSON object/);
}

async function testBoundClientSignViewTagsScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () =>
    jsonResponse({
      signature: { algorithm: "HMAC-SHA256", value: "x", signed_at: "z" },
      canonical_payload: "{}"
    })
  );
  try {
    const client = createAgentRuntimeClient("sandbox");
    await client.signView({ schema: "aamp.view/1", panels: [] });
    // The bound client tags the call with its scope. The runtime's middleware
    // is what 403s — this module must NOT silently strip the header to dodge
    // the security boundary, because that would hide policy violations.
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
  } finally {
    stub.restore();
  }
}

async function testBoundClientVerifyViewTagsScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse({ valid: true }));
  try {
    const client = createAgentRuntimeClient("read_only");
    await client.verifyView({ a: 1 }, { algorithm: "HMAC-SHA256", value: "x", signed_at: "z" });
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "read_only");
  } finally {
    stub.restore();
  }
}

async function testBoundClientDoesNotLeakScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () =>
    jsonResponse({
      signature: { algorithm: "HMAC-SHA256", value: "x", signed_at: "z" },
      canonical_payload: "{}"
    })
  );
  try {
    const client = createAgentRuntimeClient("sandbox");
    await client.signView({ schema: "aamp.view/1", panels: [] });
    // After the bound call returns, the module-level active scope must be
    // back to null so unrelated parallel human-driven traffic doesn't
    // inherit "sandbox" from this turn.
    assert.equal(getActiveAgentScope(), null);
  } finally {
    stub.restore();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
