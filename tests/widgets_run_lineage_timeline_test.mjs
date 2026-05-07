#!/usr/bin/env node
//
// ADR-001 Phase C — run.lineage_timeline widget tests.
//
// First widget that exercises the runtime client in test scope. The runtime
// is stubbed via the same pattern used for the markdown widget — pass a
// `runtimeClient` override on options, the widget never touches global
// fetch.

import assert from "node:assert/strict";

import {
  createLineageTimelineWidget,
  __testing as ltTesting
} from "../app/L0/_all/mod/_prime_silo/widgets/run/lineage_timeline/index.js";

async function main() {
  testBuildEventsPath();
  testPickTripleParts();
  testRenderShellEmptyState();
  testRenderEventColourCodingClassesPresent();
  await testWidgetLoadsAndRendersTimeline();
  await testWidgetSurfacesError();
  await testWidgetRequiresRunId();
  await testWidgetUpdateReloadsOnRunIdChange();
  await testWidgetUpdateNoReloadWhenQueryUnchanged();
  await testWidgetExposesLoadedEvents();
  console.log("widgets_run_lineage_timeline_test: ok");
}

function testBuildEventsPath() {
  assert.equal(
    ltTesting.buildEventsPath({ run_id: "r1" }),
    "/governance/events?workspace=default&run_id=r1"
  );
  assert.equal(
    ltTesting.buildEventsPath({
      run_id: "r1",
      workspace: "ws_a",
      eventType: "AGENT_AUTHORSHIP",
      limit: 50
    }),
    "/governance/events?workspace=ws_a&run_id=r1&event_type=AGENT_AUTHORSHIP&limit=50"
  );
}

function testPickTripleParts() {
  const ev1 = { data: { process: "p", skill: "s", data: "d", outcome: "ok" } };
  assert.deepEqual(ltTesting.pickTripleParts(ev1), {
    process: "p",
    skill: "s",
    data: "d",
    outcome: "ok"
  });

  const ev2 = {
    data: {
      details: { process: "nested_p", skill: "nested_s" },
      sandbox_path: "agent_sandbox/notes/x.md"
    }
  };
  const parts = ltTesting.pickTripleParts(ev2);
  assert.equal(parts.process, "nested_p");
  assert.equal(parts.skill, "nested_s");
  assert.equal(parts.data, "agent_sandbox/notes/x.md");
}

function testRenderShellEmptyState() {
  const html = ltTesting.renderShell([], { run_id: "rX", workspace: "ws_a" });
  assert.match(html, /No lineage events for run/);
  assert.match(html, /<code>rX<\/code>/);
  assert.match(html, /<code>ws_a<\/code>/);
}

function testRenderEventColourCodingClassesPresent() {
  const html = ltTesting.renderEvent({
    timestamp: "2026-05-07T12:00:00Z",
    event_type: "AGENT_AUTHORSHIP",
    data: { process: "agent_authorship", skill: "text.markdown", data: "agent_sandbox/notes/x.md" },
    _integrity_hash: "deadbeef"
  });
  assert.match(html, /data-event-type="AGENT_AUTHORSHIP"/);
  assert.match(html, /verified/);
  assert.match(html, /agent_authorship/);
  assert.match(html, /text\.markdown/);
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

async function testWidgetLoadsAndRendersTimeline() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = (path) => {
    assert.match(path, /\/governance\/events\?workspace=ws_a&run_id=r1/);
    return jsonResponse({
      workspace: "ws_a",
      run_id: "r1",
      count: 2,
      events: [
        {
          timestamp: "2026-05-07T12:00:00Z",
          event_type: "AGENT_AUTHORSHIP",
          data: { process: "agent_authorship", skill: "text.markdown", data: "agent_sandbox/notes/exposure.md" },
          _integrity_hash: "abc"
        },
        {
          timestamp: "2026-05-07T11:55:00Z",
          event_type: "TEST",
          data: { process: "test", skill: "harness", data: "n/a" }
        }
      ]
    });
  };

  createLineageTimelineWidget(
    host,
    { run_id: "r1", workspace: "ws_a" },
    { runtimeClient: client }
  );
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /AGENT_AUTHORSHIP/);
  assert.match(host.innerHTML, /text\.markdown/);
  assert.match(host.innerHTML, /unverified/);
  assert.match(host.innerHTML, /verified/);
  assert.equal(client.calls.length, 1);
}

async function testWidgetSurfacesError() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => makeRuntimeError(500, "audit log unreadable");

  createLineageTimelineWidget(
    host,
    { run_id: "r1" },
    { runtimeClient: client }
  );
  await settle();

  assert.equal(host.dataset.widgetState, "error");
  assert.match(host.innerHTML, /audit log unreadable/);
}

async function testWidgetRequiresRunId() {
  const host = createFakeHost();
  const client = createClientStub();
  createLineageTimelineWidget(host, {}, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "error");
  assert.match(host.innerHTML, /requires props\.run_id/);
  // No fetch should have happened.
  assert.equal(client.calls.length, 0);
}

async function testWidgetUpdateReloadsOnRunIdChange() {
  const host = createFakeHost();
  const client = createClientStub();
  let nthLoad = 0;
  client.runtimeHandler = (path) => {
    nthLoad += 1;
    if (nthLoad === 1) {
      assert.match(path, /run_id=first/);
      return jsonResponse({ events: [{ timestamp: "t1", event_type: "TEST", data: {} }] });
    }
    assert.match(path, /run_id=second/);
    return jsonResponse({ events: [{ timestamp: "t2", event_type: "OTHER", data: {} }] });
  };

  const widget = createLineageTimelineWidget(
    host,
    { run_id: "first" },
    { runtimeClient: client }
  );
  await settle();
  widget.update({ run_id: "second" });
  await settle();

  assert.equal(nthLoad, 2);
  assert.match(host.innerHTML, /OTHER/);
  assert.doesNotMatch(host.innerHTML, /TEST/);
}

async function testWidgetUpdateNoReloadWhenQueryUnchanged() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse({ events: [] });

  const widget = createLineageTimelineWidget(
    host,
    { run_id: "stable" },
    { runtimeClient: client }
  );
  await settle();
  // Update with the same run_id and an unrelated prop change.
  widget.update({ run_id: "stable" });
  await settle();
  assert.equal(client.calls.length, 1, "no reload when query is identical");
}

async function testWidgetExposesLoadedEvents() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () =>
    jsonResponse({
      events: [
        { timestamp: "t1", event_type: "A", data: {} },
        { timestamp: "t2", event_type: "B", data: {} }
      ]
    });

  const widget = createLineageTimelineWidget(
    host,
    { run_id: "r1" },
    { runtimeClient: client }
  );
  await settle();

  assert.equal(widget.events.length, 2);
  assert.equal(widget.events[0].event_type, "A");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
