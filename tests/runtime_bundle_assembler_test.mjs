#!/usr/bin/env node
//
// Runtime bundle assembler — pure logic + manifest-only assembly.
//
// The heavy download/pip/extract path runs only on a real per-platform build;
// here we verify the parts that must be right regardless: platform/arch → pinned
// component resolution, requirements filtering (dev/test stripped), the
// bundle.json manifest shape + entry points, and a --manifest-only run against
// the real repo into a temp dir.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const a = require("../packaging/scripts/assemble-runtime-bundle.js");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  testResolvers();
  testRequirementsFilter();
  testManifest();
  await testManifestOnlyBuild();
  console.log("runtime_bundle_assembler_test: ok");
}

function testResolvers() {
  const py = a.resolvePythonBuild("win32", "x64");
  assert.match(py.url, /python-build-standalone/);
  assert.match(py.url, /windows-msvc-install_only\.tar\.gz$/);
  const neo = a.resolveNeo4jBuild("win32");
  assert.match(neo.url, /neo4j-community-.*-windows\.zip$/);
  const jre = a.resolveJreBuild("win32", "x64");
  assert.match(jre.url, /adoptium\.net.*windows\/x64\/jre/);
  // Phase-2 platforms throw clearly rather than silently misbuilding.
  assert.throws(() => a.resolvePythonBuild("darwin", "arm64"), /Phase 2/);
  // Neo4j unix is derivable for mac/linux.
  assert.match(a.resolveNeo4jBuild("linux").url, /unix\.tar\.gz$/);
}

function testRequirementsFilter() {
  const reqs = a.filterRuntimeRequirements(`fastapi>=0.115.0
# a comment
neo4j>=5.25.0

# Dev/Test
pytest>=8.0.0
ruff>=0.8.0`);
  assert.ok(reqs.includes("fastapi>=0.115.0"));
  assert.ok(reqs.includes("neo4j>=5.25.0"));
  assert.ok(!reqs.some((r) => /pytest|ruff/.test(r)), "dev/test deps stripped");
  assert.ok(!reqs.some((r) => r.startsWith("#")), "comments stripped");
}

function testManifest() {
  const m = a.buildBundleManifest({ platform: "win32", arch: "x64", projectRoot });
  assert.equal(m.schema, "prime-silo.runtime-bundle/1");
  assert.equal(m.platform, "win32");
  assert.equal(m.entry.python, "python/python.exe");
  assert.equal(m.entry.neo4j, "neo4j/bin/neo4j.bat");
  assert.match(m.entry.api, /uvicorn benny\.api\.server:app/);
  assert.ok(m.components.python && m.components.neo4j && m.components.jre);

  const posix = a.buildBundleManifest({ platform: "linux", arch: "x64", projectRoot });
  assert.equal(posix.entry.python, "python/bin/python3");
  assert.equal(posix.entry.java, "jre/bin/java");
}

async function testManifestOnlyBuild() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-runtime-bundle-"));
  try {
    const result = await a.buildRuntimeBundle({
      platform: "win32", arch: "x64", projectRoot, outDir, manifestOnly: true
    });
    assert.equal(result.manifestOnly, true);
    assert.ok(fs.existsSync(path.join(outDir, "bundle.json")));
    assert.ok(fs.existsSync(path.join(outDir, "requirements.runtime.txt")));
    const reqs = fs.readFileSync(path.join(outDir, "requirements.runtime.txt"), "utf8");
    assert.match(reqs, /fastapi/);
    assert.ok(!/pytest/.test(reqs), "shipped requirements exclude dev/test");
    assert.ok(result.requirements.length > 5);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
