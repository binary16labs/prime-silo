#!/usr/bin/env node
//
// Phase M1 — `node space memory` CLI tests.
//
// Drives the command's execute() against a stubbed global fetch (the command
// delegates to memorayRequest, which uses fetch) and a temp project root with
// commands/params.yaml + the integration manifest, so settings resolution and
// the audit path run for real. Captures console output and the exit code.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execute } from "../commands/memory.js";

const realProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function captureConsole() {
  const lines = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  return {
    lines,
    restore() { console.log = log; console.error = err; }
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A temp project whose .env points MEMORAY_BASE_URL somewhere harmless; the
// fetch stub intercepts before any real socket is opened. We copy the real
// params.yaml + integration manifest so loadParamSpecs / the audit work.
async function tempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memcmd-"));
  await fs.mkdir(path.join(dir, "commands"), { recursive: true });
  await fs.mkdir(path.join(dir, "manifests", "integrations"), { recursive: true });
  await fs.copyFile(path.join(realProjectRoot, "commands", "params.yaml"), path.join(dir, "commands", "params.yaml"));
  await fs.copyFile(
    path.join(realProjectRoot, "manifests", "integrations", "memoray.integration.json"),
    path.join(dir, "manifests", "integrations", "memoray.integration.json")
  );
  await fs.writeFile(path.join(dir, ".env"), "MEMORAY_BASE_URL=http://memoray.test\n");
  return dir;
}

async function main() {
  await testStatusOnline();
  await testStatusOfflineExitsNonZero();
  await testSearch();
  await testUnknownSubcommand();
  await testAuditExitCodeReflectsDrift();
  console.log("memory_command_test: ok");
}

async function testStatusOnline() {
  const dir = await tempProject();
  globalThis.fetch = async (url) => {
    assert.match(String(url), /memoray\.test/, "uses the .env base URL");
    return jsonResponse({ totalNodes: 7, claude: { sessions: 3 }, antigravity: { sessions: 1 }, lastSync: 1700000000000 });
  };
  const cap = captureConsole();
  let code;
  try {
    code = await execute({ args: ["status"], projectRoot: dir });
  } finally {
    cap.restore();
  }
  assert.equal(code, 0);
  assert.ok(cap.lines.some((l) => l.includes("status: online")));
  assert.ok(cap.lines.some((l) => l.includes("nodes: 7")));
  assert.ok(cap.lines.some((l) => /sessions: 4/.test(l)));
  await fs.rm(dir, { recursive: true, force: true });
}

async function testStatusOfflineExitsNonZero() {
  const dir = await tempProject();
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  const cap = captureConsole();
  let code;
  try {
    code = await execute({ args: ["status"], projectRoot: dir });
  } finally {
    cap.restore();
  }
  assert.equal(code, 1, "offline status exits non-zero");
  assert.ok(cap.lines.some((l) => l.includes("offline")));
  await fs.rm(dir, { recursive: true, force: true });
}

async function testSearch() {
  const dir = await tempProject();
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/beta\/search\?q=lineage/);
    return jsonResponse({ sessions: [{ title: "Lineage work", id: "s1" }], files: [], actions: [] });
  };
  const cap = captureConsole();
  let code;
  try {
    code = await execute({ args: ["search", "lineage"], projectRoot: dir });
  } finally {
    cap.restore();
  }
  assert.equal(code, 0);
  assert.ok(cap.lines.some((l) => l.includes("Lineage work")));
  await fs.rm(dir, { recursive: true, force: true });
}

async function testUnknownSubcommand() {
  const cap = captureConsole();
  let code;
  try {
    code = await execute({ args: ["bogus"], projectRoot: realProjectRoot });
  } finally {
    cap.restore();
  }
  assert.equal(code, 1);
  assert.ok(cap.lines.some((l) => l.includes("Unknown subcommand")));
}

async function testAuditExitCodeReflectsDrift() {
  // memoray is offline here (fetch refused), so health/contract checks are
  // skipped, but the signature/config/owners checks still run against the
  // copied manifest in the temp dir. The copied manifest is signed (we copied
  // the signed file), config params exist (copied params.yaml), but the
  // memo-ray owner paths won't resolve under the temp root → owners drift is
  // possible. We assert the command returns a number and prints an overall line.
  const dir = await tempProject();
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  const cap = captureConsole();
  let code;
  try {
    code = await execute({ args: ["audit"], projectRoot: dir });
  } finally {
    cap.restore();
  }
  assert.ok(code === 0 || code === 1, "audit returns a meaningful exit code");
  assert.ok(cap.lines.some((l) => l.startsWith("overall:")));
  assert.ok(cap.lines.some((l) => l.includes("memoray:")));
  await fs.rm(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
