#!/usr/bin/env node
//
// Phase B-Bridge — Documents mode golden-path tests.
//
// Drives the page factory's data methods (no DOM) against a stubbed global
// fetch: the files listing maps the runtime's {data_in} shape, and the ingest
// button pushes POST /rag/ingest with the active workspace in the body — the
// no-copy-paste documents->triples path.

import assert from "node:assert/strict";

globalThis.window = globalThis.window || { location: { hash: "" } };

const { createBridgePage } = await import("../app/L0/_all/mod/_prime_silo/bridge/bridge.js");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makePage() {
  const page = createBridgePage({ context: { set() {}, dispatch: async () => ({ ok: true }) } });
  page.$refs = {};
  page.$nextTick = async () => {};
  return page;
}

async function main() {
  await testLoadFilesMapsDataIn();
  await testIngestPushesWorkspace();
  await testCorrelatePushesWorkspace();
  console.log("bridge_documents_test: ok");
}

async function testLoadFilesMapsDataIn() {
  const page = makePage();
  page.workspace = "c5_test";
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/runtime\/files\?workspace=c5_test/);
    return jsonResponse({ workspace: "c5_test", data_in: ["uml.pdf", { name: "notes.md" }], total: 2 });
  };
  await page.loadFiles();
  assert.equal(page.files.length, 2);
  assert.equal(page.files[0].name, "uml.pdf");
  assert.equal(page.files[1].name, "notes.md");
}

async function testIngestPushesWorkspace() {
  const page = makePage();
  page.workspace = "c5_test";
  let captured = null;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/api\/runtime\/rag\/ingest/);
    assert.equal(init.method, "POST");
    captured = JSON.parse(init.body);
    return jsonResponse({ run_id: "ingest_42" });
  };
  await page.ingest();
  assert.deepEqual(captured, { workspace: "c5_test" });
  assert.match(page.ingestNote, /ingest_42/i);
  assert.equal(page.ingesting, false);
}

async function testCorrelatePushesWorkspace() {
  const page = makePage();
  page.workspace = "c5_test";
  let captured = null;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/api\/runtime\/rag\/correlate/);
    captured = JSON.parse(init.body);
    return jsonResponse({ status: "ok" });
  };
  await page.correlate();
  assert.deepEqual(captured, { workspace: "c5_test" });
  assert.match(page.ingestNote, /CORRELATES_WITH|Code 3D/);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
