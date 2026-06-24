#!/usr/bin/env node
//
// ADR-001 Phase D3 — saved-view helpers on runtime-client.js.
//
// Stubs window.fetch so the tests never touch a real shell or runtime.
// Verifies: saveView posts to the chokepoint endpoint, stringifies object
// content, forwards agent_id, picks up active scope, the loadView default
// parses content as JSON, listViews returns the entries array by default,
// and the bound runtime client tags every saved-view call without leaking
// the scope into module-level state.

import assert from "node:assert/strict";

import {
  saveView,
  loadView,
  listViews,
  createAgentRuntimeClient,
  withAgentScope,
  getActiveAgentScope,
  __testing
} from "../app/L0/_all/mod/_prime_silo/runtime_client/runtime-client.js";

async function main() {
  __testing.resetAgentScope();

  await testSaveViewPostsCanonicalPayload();
  await testSaveViewStringifiesObjectContent();
  await testSaveViewPicksUpActiveScope();
  await testSaveViewExplicitAgentIdWins();
  await testSaveViewRejectsNullContent();

  await testLoadViewParsesJsonByDefault();
  await testLoadViewSkipsParseWhenAsked();
  await testLoadViewRaisesOnInvalidJson();

  await testListViewsReturnsEntriesArray();
  await testListViewsRawEnvelope();
  await testListViewsHandlesEmptyEnvelope();

  await testBoundClientSaveViewTagsScope();
  await testBoundClientLoadViewTagsScope();
  await testBoundClientListViewsTagsScope();
  await testBoundClientDoesNotLeakScope();
  await testBoundClientReadOnlyScopeStillWritesViaHeader();

  await testSaveView403RaisesRuntimeError();

  console.log("runtime_client_saved_views_test: ok");
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

async function testSaveViewPostsCanonicalPayload() {
  const stub = installFetchStub(async () =>
    jsonResponse({
      status: "written",
      workspace: "c5_test",
      relative_path: "agent_sandbox/views/compose.aamp.view",
      bytes_written: 42
    })
  );
  try {
    const out = await saveView("c5_test", "compose.aamp.view", '{"foo":1}');
    assert.equal(out.status, "written");
    assert.equal(out.relative_path, "agent_sandbox/views/compose.aamp.view");
    const call = stub.calls[0];
    assert.equal(call.method, "POST");
    assert.match(call.url, /\/api\/runtime\/agent_sandbox\/views\/save$/);
    assert.equal(call.headers["content-type"], "application/json");
    const body = JSON.parse(call.body);
    assert.deepEqual(body, {
      workspace: "c5_test",
      subdir: "views",
      filename: "compose.aamp.view",
      content: '{"foo":1}',
      agent_id: "anonymous_agent"
    });
  } finally {
    stub.restore();
  }
}

async function testSaveViewStringifiesObjectContent() {
  const stub = installFetchStub(async () =>
    jsonResponse({ status: "written", workspace: "w", relative_path: "p", bytes_written: 1 })
  );
  try {
    const view = { schema: "aamp.view/1", panels: [{ widget: "text.markdown" }] };
    await saveView("w", "v.aamp.view", view);
    const sentBody = JSON.parse(stub.calls[0].body);
    // The runtime endpoint validates that `content` parses as JSON, so the
    // helper must stringify objects before send (NOT pass them through raw).
    assert.equal(typeof sentBody.content, "string");
    assert.deepEqual(JSON.parse(sentBody.content), view);
  } finally {
    stub.restore();
  }
}

async function testSaveViewPicksUpActiveScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () =>
    jsonResponse({ status: "written", workspace: "w", relative_path: "p", bytes_written: 1 })
  );
  try {
    await withAgentScope("sandbox", () => saveView("w", "v.aamp.view", { ok: true }));
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
    // And the scope is gone after the block — saveView didn't mutate state.
    assert.equal(getActiveAgentScope(), null);
  } finally {
    stub.restore();
  }
}

async function testSaveViewExplicitAgentIdWins() {
  const stub = installFetchStub(async () =>
    jsonResponse({ status: "written", workspace: "w", relative_path: "p", bytes_written: 1 })
  );
  try {
    await saveView("w", "v.aamp.view", { ok: true }, { agentId: "agentamp.composer" });
    const body = JSON.parse(stub.calls[0].body);
    assert.equal(body.agent_id, "agentamp.composer");
  } finally {
    stub.restore();
  }
}

async function testSaveViewRejectsNullContent() {
  await assert.rejects(() => saveView("w", "v.aamp.view", null), /JSON-serialisable/);
  await assert.rejects(() => saveView("w", "v.aamp.view", undefined), /JSON-serialisable/);
}

async function testLoadViewParsesJsonByDefault() {
  const view = { schema: "aamp.view/1", panels: [] };
  const stub = installFetchStub(async (url) => {
    assert.match(url, /\/api\/runtime\/agent_sandbox\/read\/c5_test\/views\/compose\.aamp\.view$/);
    return jsonResponse({
      workspace: "c5_test",
      subdir: "views",
      filename: "compose.aamp.view",
      relative_path: "agent_sandbox/views/compose.aamp.view",
      content: JSON.stringify(view),
      bytes: 32
    });
  });
  try {
    const out = await loadView("c5_test", "compose.aamp.view");
    assert.equal(typeof out.content, "string");
    assert.deepEqual(out.view, view);
  } finally {
    stub.restore();
  }
}

async function testLoadViewSkipsParseWhenAsked() {
  const stub = installFetchStub(async () =>
    jsonResponse({
      workspace: "w",
      subdir: "views",
      filename: "v.aamp.view",
      relative_path: "agent_sandbox/views/v.aamp.view",
      content: "not valid json",
      bytes: 14
    })
  );
  try {
    const out = await loadView("w", "v.aamp.view", { parseJson: false });
    assert.equal(out.content, "not valid json");
    assert.equal(out.view, undefined);
  } finally {
    stub.restore();
  }
}

async function testLoadViewRaisesOnInvalidJson() {
  const stub = installFetchStub(async () =>
    jsonResponse({
      workspace: "w",
      subdir: "views",
      filename: "v.aamp.view",
      relative_path: "agent_sandbox/views/v.aamp.view",
      content: "{not-json",
      bytes: 9
    })
  );
  try {
    await assert.rejects(loadView("w", "v.aamp.view"), /not valid JSON/);
  } finally {
    stub.restore();
  }
}

async function testListViewsReturnsEntriesArray() {
  const stub = installFetchStub(async (url) => {
    assert.match(url, /\/api\/runtime\/agent_sandbox\/list\/c5_test\/views$/);
    return jsonResponse({
      workspace: "c5_test",
      subdir: "views",
      entries: ["a.aamp.view", "b.aamp.view"]
    });
  });
  try {
    const entries = await listViews("c5_test");
    assert.deepEqual(entries, ["a.aamp.view", "b.aamp.view"]);
  } finally {
    stub.restore();
  }
}

async function testListViewsRawEnvelope() {
  const stub = installFetchStub(async () =>
    jsonResponse({ workspace: "w", subdir: "views", entries: ["x"] })
  );
  try {
    const env = await listViews("w", { raw: true });
    assert.deepEqual(env, { workspace: "w", subdir: "views", entries: ["x"] });
  } finally {
    stub.restore();
  }
}

async function testListViewsHandlesEmptyEnvelope() {
  const stub = installFetchStub(async () => jsonResponse(null));
  try {
    const entries = await listViews("w");
    assert.deepEqual(entries, []);
  } finally {
    stub.restore();
  }
}

async function testBoundClientSaveViewTagsScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () =>
    jsonResponse({ status: "written", workspace: "w", relative_path: "p", bytes_written: 1 })
  );
  try {
    const client = createAgentRuntimeClient("sandbox");
    await client.saveView("w", "v.aamp.view", { ok: true }, { agentId: "a" });
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
    const body = JSON.parse(stub.calls[0].body);
    assert.equal(body.agent_id, "a");
  } finally {
    stub.restore();
  }
}

async function testBoundClientLoadViewTagsScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () =>
    jsonResponse({
      workspace: "w",
      subdir: "views",
      filename: "v.aamp.view",
      relative_path: "p",
      content: "{}",
      bytes: 2
    })
  );
  try {
    const client = createAgentRuntimeClient("read_only");
    const out = await client.loadView("w", "v.aamp.view");
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "read_only");
    assert.deepEqual(out.view, {});
  } finally {
    stub.restore();
  }
}

async function testBoundClientListViewsTagsScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () =>
    jsonResponse({ workspace: "w", subdir: "views", entries: ["x"] })
  );
  try {
    const client = createAgentRuntimeClient("sandbox");
    const out = await client.listViews("w");
    assert.deepEqual(out, ["x"]);
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "sandbox");
  } finally {
    stub.restore();
  }
}

async function testBoundClientDoesNotLeakScope() {
  __testing.resetAgentScope();
  const stub = installFetchStub(async () =>
    jsonResponse({ workspace: "w", subdir: "views", entries: [] })
  );
  try {
    const client = createAgentRuntimeClient("sandbox");
    await client.listViews("w");
    // The bound client uses withAgentScope internally to apply the scope to
    // the saveView/loadView/listViews helpers. After the call returns the
    // module-level active scope must be back to null so unrelated
    // human-driven traffic in parallel doesn't inherit "sandbox".
    assert.equal(getActiveAgentScope(), null);
  } finally {
    stub.restore();
  }
}

async function testBoundClientReadOnlyScopeStillWritesViaHeader() {
  // The bound client tags whatever scope it was constructed with — the runtime
  // (not this module) decides whether the scope is allowed to write. We assert
  // here that read_only saveView calls go out with the correct header so the
  // 403 is the runtime's decision, not silently downgraded by the client.
  const stub = installFetchStub(
    async () =>
      new Response(JSON.stringify({ detail: "agent write outside sandbox" }), {
        status: 403,
        headers: { "content-type": "application/json" }
      })
  );
  try {
    const client = createAgentRuntimeClient("read_only");
    let raised = null;
    try {
      await client.saveView("w", "v.aamp.view", { ok: true });
    } catch (err) {
      raised = err;
    }
    assert.ok(raised, "expected RuntimeError");
    assert.equal(raised.status, 403);
    assert.equal(stub.calls[0].headers["x-benny-agent-scope"], "read_only");
  } finally {
    stub.restore();
  }
}

async function testSaveView403RaisesRuntimeError() {
  const stub = installFetchStub(
    async () =>
      new Response(JSON.stringify({ detail: "View content must be valid JSON" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      })
  );
  try {
    let raised = null;
    try {
      await saveView("w", "v.aamp.view", "not valid json");
    } catch (err) {
      raised = err;
    }
    assert.ok(raised, "expected RuntimeError");
    assert.equal(raised.name, "RuntimeError");
    assert.equal(raised.status, 400);
    assert.match(raised.message, /must be valid JSON/);
  } finally {
    stub.restore();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
