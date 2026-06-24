#!/usr/bin/env node
//
// ADR-001 Phase F2 — pinView helper on runtime-client.js.
//
// Stubs window.fetch so the tests never touch a real shell or runtime.
// Verifies: pinView posts the canonical payload, optional fields are
// forwarded only when supplied, the bound-client variant tags the scope
// header so the runtime can issue the intended 403, and required-input
// validation rejects empty workspace/source.

import assert from "node:assert/strict";

import {
  pinView,
  createAgentRuntimeClient,
  getActiveAgentScope,
  __testing
} from "../app/L0/_all/mod/_prime_silo/runtime_client/runtime-client.js";

async function main() {
  __testing.resetAgentScope();

  await testPinViewPostsMinimalPayload();
  await testPinViewIncludesOptionalFieldsWhenSet();
  await testPinViewOmitsOptionalFieldsByDefault();
  await testPinViewRequiresWorkspace();
  await testPinViewRequiresSourceFilename();
  await testPinViewSurfaces403AsRuntimeError();
  await testPinViewReturnsRuntimeEnvelope();

  await testBoundClientPinViewTagsScope();
  await testBoundClientPinViewDoesNotLeakScope();

  console.log("runtime_client_pin_view_test: ok");
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

function pinSuccessEnvelope() {
  return {
    workspace: "c5_test",
    source_relative_path: "agent_sandbox/views/draft.aamp.view",
    pinned_relative_path: "views/draft.aamp.view",
    bytes_written: 128,
    signature: {
      algorithm: "HMAC-SHA256",
      value: "ab".repeat(32),
      signed_at: "2026-05-08T00:00:00+00:00"
    }
  };
}

async function testPinViewPostsMinimalPayload() {
  const stub = installFetchStub(async () => jsonResponse(pinSuccessEnvelope()));
  try {
    await pinView("c5_test", "draft.aamp.view");
    const call = stub.calls[0];
    assert.equal(call.method, "POST");
    assert.match(call.url, /\/api\/runtime\/views\/pin$/);
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(call.body), {
      workspace: "c5_test",
      source_filename: "draft.aamp.view"
    });
  } finally {
    stub.restore();
  }
}

async function testPinViewIncludesOptionalFieldsWhenSet() {
  const stub = installFetchStub(async () => jsonResponse(pinSuccessEnvelope()));
  try {
    await pinView("c5_test", "draft.aamp.view", {
      targetFilename: "exposure_review.aamp.view",
      pinnedBy: "operator@binary16"
    });
    const body = JSON.parse(stub.calls[0].body);
    assert.equal(body.target_filename, "exposure_review.aamp.view");
    assert.equal(body.pinned_by, "operator@binary16");
  } finally {
    stub.restore();
  }
}

async function testPinViewOmitsOptionalFieldsByDefault() {
  const stub = installFetchStub(async () => jsonResponse(pinSuccessEnvelope()));
  try {
    await pinView("c5_test", "draft.aamp.view");
    const body = JSON.parse(stub.calls[0].body);
    // Critical: don't send empty/undefined optional fields. Pydantic on the
    // server defaults to source_filename when target_filename is absent and
    // to "anonymous_human" when pinned_by is absent — sending nulls would
    // fight that default.
    assert.equal("target_filename" in body, false);
    assert.equal("pinned_by" in body, false);
  } finally {
    stub.restore();
  }
}

async function testPinViewRequiresWorkspace() {
  await assert.rejects(() => pinView("", "draft.aamp.view"), /workspace is required/);
  await assert.rejects(() => pinView(null, "draft.aamp.view"), /workspace is required/);
}

async function testPinViewRequiresSourceFilename() {
  await assert.rejects(() => pinView("c5_test", ""), /sourceFilename is required/);
  await assert.rejects(() => pinView("c5_test", null), /sourceFilename is required/);
}

async function testPinViewSurfaces403AsRuntimeError() {
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
      await pinView("c5_test", "draft.aamp.view");
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

async function testPinViewReturnsRuntimeEnvelope() {
  const envelope = pinSuccessEnvelope();
  const stub = installFetchStub(async () => jsonResponse(envelope));
  try {
    const out = await pinView("c5_test", "draft.aamp.view");
    assert.deepEqual(out, envelope);
  } finally {
    stub.restore();
  }
}

async function testBoundClientPinViewTagsScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse(pinSuccessEnvelope()));
  try {
    const client = createAgentRuntimeClient("sandbox");
    // Note: a real call here would 403 against the runtime, but our fetch
    // stub returns 200 to isolate the wire-shape check. The point of the
    // test is that the scope header IS on the wire — the runtime is the
    // enforcer; this module never silently strips.
    await client.pinView("c5_test", "draft.aamp.view");
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
  } finally {
    stub.restore();
  }
}

async function testBoundClientPinViewDoesNotLeakScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () => jsonResponse(pinSuccessEnvelope()));
  try {
    const client = createAgentRuntimeClient("sandbox");
    await client.pinView("c5_test", "draft.aamp.view");
    assert.equal(getActiveAgentScope(), null);
  } finally {
    stub.restore();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
