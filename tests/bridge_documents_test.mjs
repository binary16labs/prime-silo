#!/usr/bin/env node
//
// Phase B-Bridge — Documents mode golden-path tests.
//
// Drives the page factory's data methods (no DOM) against a stubbed global
// fetch: the files listing maps the runtime's {data_in} shape and reconciles it
// with the /rag/indexing-manifest so each row carries its ingestion status; the
// ingest button pushes POST /rag/ingest; drag-drop upload posts multipart to
// /files/upload; and Rescan hits /files/recursive-scan — the no-copy-paste
// documents->triples path with honest per-file state.

import assert from "node:assert/strict";

globalThis.window = globalThis.window || { location: { hash: "" } };

const { createBridgePage, __testing } =
  await import("../app/L0/_all/mod/_prime_silo/bridge/bridge.js");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function makePage() {
  const page = createBridgePage({ context: { set() {}, dispatch: async () => ({ ok: true }) } });
  page.$refs = {};
  page.$nextTick = async () => {};
  return page;
}

async function main() {
  testMergeFileStatus();
  await testLoadFilesMapsDataIn();
  await testLoadFilesMergesIngestionStatus();
  await testUploadPostsMultipart();
  await testRescanWorkspace();
  await testIngestPushesWorkspace();
  await testCorrelatePushesWorkspace();
  console.log("bridge_documents_test: ok");
  // Clear any pending refresh timers (ingest schedules a loadFiles refresh) so
  // the process exits deterministically instead of firing a fetch post-suite.
  process.exit(0);
}

function testMergeFileStatus() {
  const rows = __testing.mergeFileStatus(
    ["uml.pdf", { name: "notes.md" }, "unsupported.bin"],
    [
      { name: "uml.pdf", status: "ALIGNED", chunks: 12, type: "pdf" },
      { name: "notes.md", status: "MISSING", chunks: 0, type: "md" }
    ]
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, "ALIGNED");
  assert.equal(rows[0].chunks, 12);
  assert.equal(rows[1].status, "MISSING");
  // In data_in but absent from the indexing manifest => staged.
  assert.equal(rows[2].status, "STAGED");
  assert.equal(__testing.fileStatusLabel("ALIGNED"), "Ingested");
  assert.equal(__testing.fileStatusClass("MISSING"), "is-pending");
}

async function testLoadFilesMapsDataIn() {
  const page = makePage();
  page.workspace = "c5_test";
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rag/indexing-manifest")) {
      return jsonResponse({ workspace: "c5_test", manifest: [], total_indexed: 0 });
    }
    assert.match(u, /\/api\/runtime\/files\?workspace=c5_test/);
    return jsonResponse({
      workspace: "c5_test",
      data_in: ["uml.pdf", { name: "notes.md" }],
      total: 2
    });
  };
  await page.loadFiles();
  assert.equal(page.files.length, 2);
  assert.equal(page.files[0].name, "uml.pdf");
  assert.equal(page.files[1].name, "notes.md");
  // No manifest entries yet => everything staged, all pending ingestion.
  assert.equal(page.pendingCount, 2);
}

async function testLoadFilesMergesIngestionStatus() {
  const page = makePage();
  page.workspace = "c5_test";
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rag/indexing-manifest")) {
      return jsonResponse({
        workspace: "c5_test",
        manifest: [{ name: "uml.pdf", status: "ALIGNED", chunks: 7, type: "pdf" }],
        total_indexed: 1
      });
    }
    return jsonResponse({ workspace: "c5_test", data_in: ["uml.pdf", "notes.md"], total: 2 });
  };
  await page.loadFiles();
  assert.equal(page.files[0].status, "ALIGNED");
  assert.equal(page.files[0].chunks, 7);
  assert.equal(page.files[1].status, "STAGED");
  assert.equal(page.pendingCount, 1);
}

async function testUploadPostsMultipart() {
  const page = makePage();
  page.workspace = "c5_test";
  let uploadUrl = "";
  let uploadBody = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/files/upload")) {
      uploadUrl = u;
      uploadBody = init.body;
      assert.equal(init.method, "POST");
      return jsonResponse({ status: "uploaded", filename: "notes.md" });
    }
    if (u.includes("/rag/indexing-manifest")) {
      return jsonResponse({ workspace: "c5_test", manifest: [], total_indexed: 0 });
    }
    return jsonResponse({ workspace: "c5_test", data_in: ["notes.md"], total: 1 });
  };
  // A File is a Blob with a name; FormData.append uses it directly.
  const md = new File(["# hi"], "notes.md", { type: "text/markdown" });
  const exe = new File(["nope"], "tool.exe", { type: "application/octet-stream" });
  await page.uploadFiles([md, exe]);
  assert.match(uploadUrl, /\/api\/runtime\/files\/upload\?workspace=c5_test/);
  assert.ok(uploadBody instanceof FormData, "upload body should be multipart FormData");
  assert.equal(uploadBody.get("file").name, "notes.md");
  // One accepted, one rejected (.exe is not in the allow-list).
  assert.match(page.ingestNote, /Uploaded 1 file/);
  assert.match(page.ingestNote, /Skipped 1 unsupported/);
}

async function testRescanWorkspace() {
  const page = makePage();
  page.workspace = "c5_test";
  let scanned = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/files/recursive-scan")) {
      scanned = true;
      return jsonResponse({
        workspace: "c5_test",
        files: [{ name: "a.md" }, { name: "b.pdf" }],
        total: 2
      });
    }
    if (u.includes("/rag/indexing-manifest")) {
      return jsonResponse({ workspace: "c5_test", manifest: [], total_indexed: 0 });
    }
    return jsonResponse({ workspace: "c5_test", data_in: ["a.md", "b.pdf"], total: 2 });
  };
  await page.rescanWorkspace();
  assert.ok(scanned, "rescan should call /files/recursive-scan");
  assert.match(page.ingestNote, /rescanned/i);
  assert.match(page.ingestNote, /2 files on disk/);
  assert.equal(page.rescanning, false);
}

async function testIngestPushesWorkspace() {
  const page = makePage();
  page.workspace = "c5_test";
  let captured = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/rag/ingest")) {
      assert.equal(init.method, "POST");
      captured = JSON.parse(init.body);
      return jsonResponse({ run_id: "ingest_42" });
    }
    // Tolerate the scheduled post-ingest loadFiles refresh.
    if (u.includes("/rag/indexing-manifest")) {
      return jsonResponse({ workspace: "c5_test", manifest: [], total_indexed: 0 });
    }
    return jsonResponse({ workspace: "c5_test", data_in: [], total: 0 });
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
