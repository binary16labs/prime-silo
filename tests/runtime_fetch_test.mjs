#!/usr/bin/env node
//
// First-run runtime fetch — pure helpers + the download/verify/extract flow.
//
// The real network + ~hundreds-of-MB archive are injected, so this verifies the
// logic that must be right: asset naming, release-asset URLs, the version-marker
// short-circuit, checksum verification, and graceful failure (never throws).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rf = require("../packaging/desktop/runtime_fetch.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ps-fetch-test-"));
}

// Lay down the files isBundleInstalled() checks, for a given platform.
function fakeInstall(destDir, platform = "win32") {
  const py = platform === "win32" ? "python/python.exe" : "python/bin/python3";
  for (const rel of [py, "benny/benny_cli.py", "neo4j/bin/neo4j.bat", "jre/bin/java.exe"]) {
    fs.mkdirSync(path.join(destDir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(destDir, rel), "x");
  }
}

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

async function main() {
  testNamesAndUrls();
  testShaParse();
  testMarkerAndInstalled();
  await testAlreadyPresentShortCircuits();
  await testDownloadsExtractsWritesMarker();
  await testChecksumMismatchFails();
  await testDownloadFailureIsGraceful();
  console.log("runtime_fetch_test: ok");
}

function testNamesAndUrls() {
  const n = rf.runtimeBundleAssetNames("win32", "x64");
  assert.equal(n.archive, "runtime-bundle-win32-x64.tar.gz");
  assert.equal(n.sha256, "runtime-bundle-win32-x64.tar.gz.sha256");
  assert.equal(n.manifest, "runtime-bundle-win32-x64.json");

  // Version is normalized to a v-prefixed tag; default repo is binary16labs/prime-silo.
  assert.equal(
    rf.resolveAssetUrl({ version: "1.2.9", asset: n.archive }),
    "https://github.com/binary16labs/prime-silo/releases/download/v1.2.9/runtime-bundle-win32-x64.tar.gz"
  );
  assert.equal(
    rf.resolveAssetUrl({ version: "v1.2.9", owner: "o", repo: "r", asset: "a" }),
    "https://github.com/o/r/releases/download/v1.2.9/a"
  );
}

function testShaParse() {
  assert.equal(
    rf.parseSha256Sidecar("a".repeat(64) + "  runtime-bundle-win32-x64.tar.gz"),
    "a".repeat(64)
  );
  assert.equal(rf.parseSha256Sidecar("  " + "B".repeat(64) + "\n"), "b".repeat(64));
  assert.equal(rf.parseSha256Sidecar("not-a-hash file"), "");
  assert.equal(rf.parseSha256Sidecar(""), "");
}

function testMarkerAndInstalled() {
  const dir = tmpDir();
  try {
    assert.equal(
      rf.isBundleInstalled(dir, "1.2.9", fs.existsSync, "win32"),
      false,
      "no marker → not installed"
    );
    fakeInstall(dir, "win32");
    rf.writeMarker(dir, { app_version: "1.2.9", sha256: "deadbeef" });
    assert.equal(rf.isBundleInstalled(dir, "1.2.9", fs.existsSync, "win32"), true);
    // Version mismatch → must re-fetch.
    assert.equal(rf.isBundleInstalled(dir, "1.3.0", fs.existsSync, "win32"), false);
    const m = rf.readMarker(dir);
    assert.equal(m.app_version, "1.2.9");
    assert.ok(m.installed_at);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testAlreadyPresentShortCircuits() {
  const dir = tmpDir();
  try {
    fakeInstall(dir, "win32");
    rf.writeMarker(dir, { app_version: "1.2.9", sha256: "x" });
    let downloads = 0;
    const result = await rf.ensureRuntimeBundle({
      destDir: dir,
      version: "1.2.9",
      platform: "win32",
      arch: "x64",
      downloadFn: async () => {
        downloads += 1;
        return "x";
      },
      fetchTextFn: async () => "",
      extractFn: () => {},
      logger: silentLogger()
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "already-present");
    assert.equal(downloads, 0, "must not download when already installed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testDownloadsExtractsWritesMarker() {
  const dir = tmpDir();
  try {
    const sha = "c".repeat(64);
    let extracted = false;
    const result = await rf.ensureRuntimeBundle({
      destDir: dir,
      version: "1.2.9",
      platform: "win32",
      arch: "x64",
      fetchTextFn: async () => `${sha}  runtime-bundle-win32-x64.tar.gz`,
      downloadFn: async (_url, destPath) => {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, "archive");
        return sha;
      },
      extractFn: (_archive, destDir) => {
        fakeInstall(destDir, "win32");
        extracted = true;
      },
      cacheDir: path.join(dir, "..", "ps-fetch-cache-" + Date.now()),
      logger: silentLogger()
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.reason, "downloaded");
    assert.ok(extracted);
    const marker = rf.readMarker(dir);
    assert.equal(marker.app_version, "1.2.9");
    assert.equal(marker.sha256, sha);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testChecksumMismatchFails() {
  const dir = tmpDir();
  try {
    let extracted = false;
    const result = await rf.ensureRuntimeBundle({
      destDir: dir,
      version: "1.2.9",
      platform: "win32",
      arch: "x64",
      fetchTextFn: async () => `${"a".repeat(64)}  runtime-bundle-win32-x64.tar.gz`,
      downloadFn: async (_url, destPath) => {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, "x");
        return "b".repeat(64);
      },
      extractFn: () => {
        extracted = true;
      },
      cacheDir: path.join(dir, "..", "ps-fetch-cache2-" + Date.now()),
      logger: silentLogger()
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "checksum-mismatch");
    assert.equal(extracted, false, "must not extract a corrupt download");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testDownloadFailureIsGraceful() {
  const dir = tmpDir();
  try {
    const result = await rf.ensureRuntimeBundle({
      destDir: dir,
      version: "1.2.9",
      platform: "win32",
      arch: "x64",
      fetchTextFn: async () => {
        throw new Error("offline");
      },
      downloadFn: async () => {
        throw new Error("offline");
      },
      extractFn: () => {},
      cacheDir: path.join(dir, "..", "ps-fetch-cache3-" + Date.now()),
      logger: silentLogger()
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "download-failed", "network failure resolves, never throws");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
