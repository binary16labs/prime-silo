#!/usr/bin/env node
//
// ADR-001 Phase C — run.reasoning_trace widget tests.
//
// Fifth migrated widget; third that calls the runtime. Reuses the runtime
// stub pattern (no global fetch). Verifies the widget filters
// NODE_EXECUTION_STATE events down to ones with a non-empty
// `outputs.reasoning_trace`, surfaces both happy and degraded states, and
// re-loads only when the query actually changes.

import assert from "node:assert/strict";

import {
  createReasoningTraceWidget,
  __testing as rtTesting
} from "../app/L0/_all/mod/_prime_silo/widgets/run/reasoning_trace/index.js";

async function main() {
  testBuildEventsPath();
  testExtractTracesFiltersAndShapes();
  testExtractTracesNodeIdFilter();
  testRenderStatusChipVariants();
  testRenderDuration();
  testRenderShellEmptyAndPopulated();
  await testWidgetLoadsAndRenders();
  await testWidgetEmptyStateWhenNoReasoning();
  await testWidgetSurfacesError();
  await testWidgetRequiresRunId();
  await testWidgetUpdateReloadsOnNodeIdChange();
  await testWidgetUpdateNoReloadWhenQueryUnchanged();
  await testWidgetExposesTracesAndRawEvents();
  console.log("widgets_run_reasoning_trace_test: ok");
}

function testBuildEventsPath() {
  assert.equal(
    rtTesting.buildEventsPath({ run_id: "r1" }),
    "/governance/events?workspace=default&run_id=r1&event_type=NODE_EXECUTION_STATE&limit=200"
  );
  assert.equal(
    rtTesting.buildEventsPath({
      run_id: "20260507-studio",
      workspace: "ws_a",
      limit: 50
    }),
    "/governance/events?workspace=ws_a&run_id=20260507-studio&event_type=NODE_EXECUTION_STATE&limit=50"
  );
}

function testExtractTracesFiltersAndShapes() {
  const events = [
    {
      timestamp: "2026-05-07T12:00:00Z",
      event_type: "NODE_EXECUTION_STATE",
      data: {
        node_id: "llm-1",
        status: "completed",
        timestamp: "2026-05-07T12:00:00Z",
        duration_ms: 1234,
        outputs: { reasoning_trace: "  thinking about A...  ", response: "answer A" }
      }
    },
    // No reasoning_trace — should be filtered out.
    {
      timestamp: "2026-05-07T12:00:01Z",
      data: { node_id: "tool-1", status: "completed", outputs: { response: "tool ran" } }
    },
    // Empty reasoning_trace — also filtered out.
    {
      timestamp: "2026-05-07T12:00:02Z",
      data: { node_id: "llm-2", status: "failed", outputs: { reasoning_trace: "   " } }
    },
    {
      timestamp: "2026-05-07T12:00:03Z",
      data: {
        node_id: "llm-3",
        status: "completed",
        outputs: { reasoning_trace: "considering branch B" }
      }
    }
  ];
  const traces = rtTesting.extractTraces(events, {});
  assert.equal(traces.length, 2);
  assert.equal(traces[0].node_id, "llm-1");
  assert.equal(traces[0].reasoning, "thinking about A...");
  assert.equal(traces[0].duration_ms, 1234);
  assert.equal(traces[0].response, "answer A");
  assert.equal(traces[1].node_id, "llm-3");
  assert.equal(traces[1].duration_ms, null);
}

function testExtractTracesNodeIdFilter() {
  const events = [
    { data: { node_id: "alpha", outputs: { reasoning_trace: "α" } } },
    { data: { node_id: "beta", outputs: { reasoning_trace: "β" } } }
  ];
  const traces = rtTesting.extractTraces(events, { node_id: "beta" });
  assert.equal(traces.length, 1);
  assert.equal(traces[0].node_id, "beta");
}

function testRenderStatusChipVariants() {
  assert.match(rtTesting.renderStatusChip("completed"), /prime-silo-rt__status--ok/);
  assert.match(rtTesting.renderStatusChip("success"), /prime-silo-rt__status--ok/);
  assert.match(rtTesting.renderStatusChip("failed"), /prime-silo-rt__status--err/);
  assert.match(rtTesting.renderStatusChip("error"), /prime-silo-rt__status--err/);
  assert.match(rtTesting.renderStatusChip("started"), /prime-silo-rt__status--neutral/);
  // XSS defence on status text.
  assert.match(rtTesting.renderStatusChip("<x>"), /&lt;x&gt;/);
  assert.doesNotMatch(rtTesting.renderStatusChip("<x>"), /<x>/);
}

function testRenderDuration() {
  assert.equal(rtTesting.renderDuration(null), "");
  assert.match(rtTesting.renderDuration(123), /123ms/);
  assert.match(rtTesting.renderDuration(2500), /2\.50s/);
}

function testRenderShellEmptyAndPopulated() {
  const empty = rtTesting.renderShell([], { run_id: "r1" });
  assert.match(empty, /No reasoning trace recorded/);
  assert.match(empty, /<code>r1<\/code>/);

  const emptyNode = rtTesting.renderShell([], { run_id: "r1", node_id: "alpha" });
  assert.match(emptyNode, /node <code>alpha<\/code>/);

  const populated = rtTesting.renderShell(
    [
      { node_id: "llm-1", status: "completed", timestamp: "t1", duration_ms: 200, reasoning: "step A" },
      { node_id: "llm-2", status: "failed", timestamp: "t2", duration_ms: null, reasoning: "step B" }
    ],
    { run_id: "r1" }
  );
  assert.match(populated, /2 reasoning traces/);
  assert.match(populated, /llm-1/);
  assert.match(populated, /step A/);
  assert.match(populated, /llm-2/);
  // Reasoning content should be HTML-escaped — no unescaped angle brackets.
  const xss = rtTesting.renderShell(
    [{ node_id: "x", status: "completed", timestamp: "t", duration_ms: null, reasoning: "<script>alert(1)</script>" }],
    { run_id: "r1" }
  );
  assert.match(xss, /&lt;script&gt;/);
  assert.doesNotMatch(xss, /<script>alert/);
}

class FakeClassList {
  constructor() { this._set = new Set(); }
  add(...names) { names.forEach((n) => this._set.add(n)); }
  remove(...names) { names.forEach((n) => this._set.delete(n)); }
  has(name) { return this._set.has(name); }
}

function createFakeHost() {
  return {
    classList: new FakeClassList(),
    dataset: {},
    innerHTML: "",
    querySelector: () => null
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function makeRuntimeError(status, detail) {
  const err = new Error(detail);
  err.name = "RuntimeError";
  err.status = status;
  err.body = { detail };
  return err;
}

function createClientStub() {
  const calls = [];
  const stub = {
    calls,
    runtimeHandler: null,
    runtimeFetch: null,
    readRuntimeJson: async (response) => {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
  };
  stub.runtimeFetch = async (path, init = {}) => {
    calls.push({ path, init });
    if (!stub.runtimeHandler) {
      throw new Error("no runtimeHandler installed for path " + path);
    }
    const result = stub.runtimeHandler(path, init);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  return stub;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

async function testWidgetLoadsAndRenders() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = (path) => {
    assert.match(path, /\/governance\/events\?workspace=ws_a&run_id=r1&event_type=NODE_EXECUTION_STATE/);
    return jsonResponse({
      events: [
        {
          timestamp: "2026-05-07T12:00:00Z",
          event_type: "NODE_EXECUTION_STATE",
          data: {
            node_id: "llm-classifier",
            status: "completed",
            duration_ms: 850,
            outputs: { reasoning_trace: "Considering category foo vs bar." }
          }
        },
        {
          timestamp: "2026-05-07T12:00:01Z",
          event_type: "NODE_EXECUTION_STATE",
          data: {
            node_id: "tool-1",
            status: "completed",
            outputs: { response: "(no reasoning)" }
          }
        }
      ]
    });
  };

  createReasoningTraceWidget(
    host,
    { run_id: "r1", workspace: "ws_a" },
    { runtimeClient: client }
  );
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /1 reasoning trace for run/);
  assert.match(host.innerHTML, /llm-classifier/);
  assert.match(host.innerHTML, /Considering category foo vs bar/);
  // tool-1 had no reasoning — should be filtered out of the rendered list.
  assert.doesNotMatch(host.innerHTML, /tool-1/);
  assert.equal(client.calls.length, 1);
}

async function testWidgetEmptyStateWhenNoReasoning() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () =>
    jsonResponse({
      events: [
        { data: { node_id: "tool-1", status: "completed", outputs: { response: "ran" } } }
      ]
    });

  createReasoningTraceWidget(host, { run_id: "r1" }, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /No reasoning trace recorded/);
}

async function testWidgetSurfacesError() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => makeRuntimeError(500, "audit log unreadable");

  createReasoningTraceWidget(host, { run_id: "r1" }, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "error");
  assert.match(host.innerHTML, /audit log unreadable/);
}

async function testWidgetRequiresRunId() {
  const host = createFakeHost();
  const client = createClientStub();
  createReasoningTraceWidget(host, {}, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "error");
  assert.match(host.innerHTML, /requires props\.run_id/);
  assert.equal(client.calls.length, 0);
}

async function testWidgetUpdateReloadsOnNodeIdChange() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () =>
    jsonResponse({
      events: [
        { data: { node_id: "alpha", status: "completed", outputs: { reasoning_trace: "α reasoning" } } },
        { data: { node_id: "beta", status: "completed", outputs: { reasoning_trace: "β reasoning" } } }
      ]
    });

  const widget = createReasoningTraceWidget(
    host,
    { run_id: "r1" },
    { runtimeClient: client }
  );
  await settle();
  // First load: both traces visible.
  assert.match(host.innerHTML, /α reasoning/);
  assert.match(host.innerHTML, /β reasoning/);

  widget.update({ node_id: "beta" });
  await settle();

  assert.equal(client.calls.length, 2);
  assert.match(host.innerHTML, /β reasoning/);
  assert.doesNotMatch(host.innerHTML, /α reasoning/);
}

async function testWidgetUpdateNoReloadWhenQueryUnchanged() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse({ events: [] });

  const widget = createReasoningTraceWidget(
    host,
    { run_id: "stable" },
    { runtimeClient: client }
  );
  await settle();
  widget.update({ run_id: "stable" });
  await settle();

  assert.equal(client.calls.length, 1, "no reload when query is identical");
}

async function testWidgetExposesTracesAndRawEvents() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () =>
    jsonResponse({
      events: [
        { data: { node_id: "llm-1", status: "completed", outputs: { reasoning_trace: "thought-1" } } },
        { data: { node_id: "tool-1", status: "completed", outputs: { response: "ran" } } }
      ]
    });

  const widget = createReasoningTraceWidget(
    host,
    { run_id: "r1" },
    { runtimeClient: client }
  );
  await settle();

  assert.equal(widget.traces.length, 1);
  assert.equal(widget.traces[0].node_id, "llm-1");
  assert.equal(widget.rawEvents.length, 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
