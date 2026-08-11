#!/usr/bin/env node
//
// Phase B-Bridge — `node space bridge` CLI tests.
//
// Drives execute() against a stubbed global fetch (the command delegates to
// runtimeRequest, which uses fetch). plan/run/ingest push the golden-path
// calls and print the ids; open prints the route; unknown exits non-zero.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execute } from "../commands/bridge.js";

// Hermetic: the command's runtimeRequest resolves BENNY_API_KEY before it calls fetch (and THROWS
// if none is set, which the stubbed fetch below can't reach). Give it a dummy so the test exercises
// the request-building path deterministically, independent of the host's key state.
process.env.BENNY_API_KEY = process.env.BENNY_API_KEY || "test-key";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function captureConsole() {
  const lines = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  return {
    lines,
    restore() {
      console.log = log;
      console.error = err;
    }
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function run(args) {
  const cap = captureConsole();
  let code;
  try {
    code = await execute({ args, projectRoot });
  } finally {
    cap.restore();
  }
  return { code, lines: cap.lines };
}

async function main() {
  await testOpen();
  await testPlanPushesRequirement();
  await testRunPushesManifestId();
  await testIngestPushesWorkspace();
  await testUnknown();
  console.log("bridge_command_test: ok");
}

async function testOpen() {
  const { code, lines } = await run(["open"]);
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes("#/_prime_silo/bridge")));
}

async function testPlanPushesRequirement() {
  let captured = null;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/manifests\/plan/);
    captured = JSON.parse(init.body);
    return jsonResponse({ id: "mf_abc", requirement: "score trades", nodes: [1, 2, 3] });
  };
  const { code, lines } = await run([
    "plan",
    "score trades",
    "--workspace",
    "pypes_demo",
    "--strategy",
    "auto"
  ]);
  assert.equal(code, 0);
  assert.equal(captured.requirement, "score trades");
  assert.equal(captured.workspace, "pypes_demo");
  assert.equal(captured.strategy, "auto");
  assert.ok(lines.some((l) => l.includes("planned: mf_abc")));
  assert.ok(lines.some((l) => l.includes("nodes: 3")));
}

async function testRunPushesManifestId() {
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/manifests\/mf_abc\/run/);
    assert.equal(JSON.parse(init.body).workspace, "pypes_demo");
    return jsonResponse({ run_id: "run_xyz", status: "queued" });
  };
  const { code, lines } = await run(["run", "mf_abc", "--workspace", "pypes_demo"]);
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes("run: run_xyz")));
  assert.ok(lines.some((l) => l.includes("mode=runs&id=run_xyz")));
}

async function testIngestPushesWorkspace() {
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/rag\/ingest/);
    assert.equal(JSON.parse(init.body).workspace, "c5_test");
    return jsonResponse({ run_id: "ing_1" });
  };
  const { code, lines } = await run(["ingest", "--workspace", "c5_test"]);
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes("ingest: ing_1")));
}

async function testUnknown() {
  const { code, lines } = await run(["bogus"]);
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes("Unknown subcommand")));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
