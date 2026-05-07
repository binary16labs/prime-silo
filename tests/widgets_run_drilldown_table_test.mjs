#!/usr/bin/env node
//
// ADR-001 Phase C — run.drilldown_table widget tests.
//
// Fourth migrated widget; second that calls the runtime. Stubs the runtime
// client the same way the lineage_timeline tests do — a runtimeClient
// override on options, no global fetch involvement.

import assert from "node:assert/strict";

import {
  createDrilldownTableWidget,
  __testing as dtTesting
} from "../app/L0/_all/mod/_prime_silo/widgets/run/drilldown_table/index.js";

async function main() {
  testBuildDrilldownPath();
  testFormatCellVariants();
  testRenderClpCardVariants();
  testRenderTableEmptyAndPopulated();
  await testWidgetLoadsAndRenders();
  await testWidgetSurfacesError();
  await testWidgetRequiresRunId();
  await testWidgetRequiresStepId();
  await testWidgetUpdateReloadsOnStepChange();
  await testWidgetUpdateNoReloadWhenQueryUnchanged();
  await testWidgetExposesPayload();
  console.log("widgets_run_drilldown_table_test: ok");
}

function testBuildDrilldownPath() {
  assert.equal(
    dtTesting.buildDrilldownPath({ run_id: "r1", step_id: "s1" }),
    "/pypes/runs/r1/steps/s1?workspace=default"
  );
  assert.equal(
    dtTesting.buildDrilldownPath({
      run_id: "20260507-pypes",
      step_id: "gold_exposure",
      workspace: "ws_a",
      rows: 200
    }),
    "/pypes/runs/20260507-pypes/steps/gold_exposure?workspace=ws_a&rows=200"
  );
  // run_id / step_id with characters that need encoding.
  assert.equal(
    dtTesting.buildDrilldownPath({ run_id: "a/b", step_id: "x y" }),
    "/pypes/runs/a%2Fb/steps/x%20y?workspace=default"
  );
}

function testFormatCellVariants() {
  assert.match(dtTesting.formatCell(null), /—/);
  assert.match(dtTesting.formatCell(""), /—/);
  assert.match(dtTesting.formatCell(undefined), /—/);
  assert.match(dtTesting.formatCell(42), /prime-silo-dt__num/);
  assert.match(dtTesting.formatCell({ a: 1 }), /prime-silo-dt__json/);
  assert.match(dtTesting.formatCell([1, 2]), /\[1,2\]/);
  // String escaping defends against XSS via cell values.
  assert.match(dtTesting.formatCell("<script>alert(1)</script>"), /&lt;script&gt;/);
}

function testRenderClpCardVariants() {
  const missing = dtTesting.renderClpCard({});
  assert.match(missing, /No CLP binding/);
  assert.match(missing, /prime-silo-dt__clp--missing/);

  const present = dtTesting.renderClpCard({ process: "p", skill: "s", data: "d" });
  assert.match(present, /<dt>process<\/dt>/);
  assert.match(present, /<dd>p<\/dd>/);
  assert.match(present, /<dt>data<\/dt>/);
  assert.doesNotMatch(present, /No CLP binding/);
}

function testRenderTableEmptyAndPopulated() {
  const empty = dtTesting.renderTable({ columns: [], rows: [] });
  assert.match(empty, /Step produced no rows/);

  const populated = dtTesting.renderTable({
    columns: ["entity", "exposure"],
    rows: [
      { entity: "ACME", exposure: 1234 },
      { entity: "BETA", exposure: null }
    ]
  });
  assert.match(populated, /<th[^>]*>entity<\/th>/);
  assert.match(populated, /<th[^>]*>exposure<\/th>/);
  assert.match(populated, /ACME/);
  assert.match(populated, /1234/);
  // Null cell should render as a muted dash, not "null".
  assert.match(populated, /prime-silo-dt__missing/);
  assert.doesNotMatch(populated, />null</);
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
    assert.match(path, /\/pypes\/runs\/r1\/steps\/gold_exposure\?workspace=ws_a/);
    return jsonResponse({
      run_id: "r1",
      step_id: "gold_exposure",
      row_count: 2,
      columns: ["entity", "exposure", "details"],
      clp_binding: { process: "exposure_calc", skill: "tabular", data: "trades.csv" },
      stage: "gold",
      rows: [
        { entity: "ACME", exposure: 1234, details: { sector: "energy" } },
        { entity: "BETA", exposure: 0, details: null }
      ]
    });
  };

  createDrilldownTableWidget(
    host,
    { run_id: "r1", step_id: "gold_exposure", workspace: "ws_a" },
    { runtimeClient: client }
  );
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /gold_exposure/);
  assert.match(host.innerHTML, /data-stage="gold"/);
  assert.match(host.innerHTML, /exposure_calc/);
  assert.match(host.innerHTML, /ACME/);
  // Nested object rendered as JSON, not "[object Object]".
  assert.match(host.innerHTML, /sector/);
  assert.doesNotMatch(host.innerHTML, /\[object Object\]/);
  assert.equal(client.calls.length, 1);
}

async function testWidgetSurfacesError() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => makeRuntimeError(404, "no checkpoint for step 'ghost'");

  createDrilldownTableWidget(
    host,
    { run_id: "r1", step_id: "ghost" },
    { runtimeClient: client }
  );
  await settle();

  assert.equal(host.dataset.widgetState, "error");
  assert.match(host.innerHTML, /no checkpoint for step/);
}

async function testWidgetRequiresRunId() {
  const host = createFakeHost();
  const client = createClientStub();
  createDrilldownTableWidget(host, { step_id: "x" }, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "error");
  assert.match(host.innerHTML, /requires props\.run_id/);
  assert.equal(client.calls.length, 0);
}

async function testWidgetRequiresStepId() {
  const host = createFakeHost();
  const client = createClientStub();
  createDrilldownTableWidget(host, { run_id: "r1" }, { runtimeClient: client });
  await settle();

  assert.equal(host.dataset.widgetState, "error");
  assert.match(host.innerHTML, /requires props\.step_id/);
  assert.equal(client.calls.length, 0);
}

async function testWidgetUpdateReloadsOnStepChange() {
  const host = createFakeHost();
  const client = createClientStub();
  let nthLoad = 0;
  client.runtimeHandler = (path) => {
    nthLoad += 1;
    if (nthLoad === 1) {
      assert.match(path, /steps\/first/);
      return jsonResponse({ columns: ["a"], rows: [{ a: 1 }], stage: "silver" });
    }
    assert.match(path, /steps\/second/);
    return jsonResponse({ columns: ["b"], rows: [{ b: 2 }], stage: "gold" });
  };

  const widget = createDrilldownTableWidget(
    host,
    { run_id: "r1", step_id: "first" },
    { runtimeClient: client }
  );
  await settle();
  widget.update({ step_id: "second" });
  await settle();

  assert.equal(nthLoad, 2);
  assert.match(host.innerHTML, /data-stage="gold"/);
  assert.doesNotMatch(host.innerHTML, /data-stage="silver"/);
}

async function testWidgetUpdateNoReloadWhenQueryUnchanged() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () => jsonResponse({ columns: [], rows: [] });

  const widget = createDrilldownTableWidget(
    host,
    { run_id: "r1", step_id: "stable" },
    { runtimeClient: client }
  );
  await settle();
  widget.update({ run_id: "r1", step_id: "stable" });
  await settle();

  assert.equal(client.calls.length, 1, "no reload when query is identical");
}

async function testWidgetExposesPayload() {
  const host = createFakeHost();
  const client = createClientStub();
  client.runtimeHandler = () =>
    jsonResponse({
      columns: ["x", "y"],
      rows: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
      clp_binding: { process: "p", skill: "s" }
    });

  const widget = createDrilldownTableWidget(
    host,
    { run_id: "r1", step_id: "s1" },
    { runtimeClient: client }
  );
  await settle();

  assert.deepEqual(widget.columns, ["x", "y"]);
  assert.equal(widget.rows.length, 2);
  assert.equal(widget.rows[0].x, 1);
  assert.equal(widget.clpBinding.process, "p");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
