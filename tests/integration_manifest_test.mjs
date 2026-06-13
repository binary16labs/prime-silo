#!/usr/bin/env node
//
// Phase M1 — integration manifest + signing tests.
//
// Verifies the canonical-payload signing scheme (matches the runtime's
// .aamp.view scheme: recursively sorted keys, idempotent over the
// `signature` field, timing-safe verify) and that the checked-in
// memoray.integration.json parses with the expected structure.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalManifestPayload,
  signManifest,
  verifyManifest
} from "../server/lib/manifest_signing.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  testCanonicalPayloadSortsRecursivelyAndStripsSignature();
  testSignVerifyRoundTrip();
  testTamperFailsVerify();
  testWrongAlgorithmFails();
  await testCheckedInManifestStructure();
  console.log("integration_manifest_test: ok");
}

function testCanonicalPayloadSortsRecursivelyAndStripsSignature() {
  const a = canonicalManifestPayload({ b: 1, a: { d: 4, c: 3 }, signature: { value: "x" } });
  const b = canonicalManifestPayload({ a: { c: 3, d: 4 }, b: 1 });
  assert.equal(a, b, "key order and a pre-existing signature must not affect the payload");
  assert.equal(a, '{"a":{"c":3,"d":4},"b":1}');
}

function testSignVerifyRoundTrip() {
  const env = { BENNY_HMAC_KEY: "ab".repeat(32) };
  const manifest = { id: "demo", data: [1, 2, 3] };
  const sig = signManifest(manifest, { env });
  assert.equal(sig.algorithm, "HMAC-SHA256");
  assert.ok(/^[0-9a-f]{64}$/.test(sig.value));
  assert.equal(verifyManifest(manifest, sig, { env }), true);
  // Embedding the signature inline still verifies (idempotent payload).
  assert.equal(verifyManifest({ ...manifest, signature: sig }, sig, { env }), true);
}

function testTamperFailsVerify() {
  const env = { BENNY_HMAC_KEY: "cd".repeat(32) };
  const manifest = { id: "demo", value: "original" };
  const sig = signManifest(manifest, { env });
  assert.equal(verifyManifest({ id: "demo", value: "TAMPERED" }, sig, { env }), false);
  // Different key fails too.
  assert.equal(verifyManifest(manifest, sig, { env: { BENNY_HMAC_KEY: "ee".repeat(32) } }), false);
}

function testWrongAlgorithmFails() {
  assert.equal(verifyManifest({ id: "x" }, { algorithm: "MD5", value: "z" }), false);
  assert.equal(verifyManifest({ id: "x" }, null), false);
}

async function testCheckedInManifestStructure() {
  const raw = await fs.readFile(
    path.join(projectRoot, "manifests", "integrations", "memoray.integration.json"),
    "utf8"
  );
  const manifest = JSON.parse(raw);
  assert.equal(manifest.schema, "aamp.integration/1");
  assert.equal(manifest.id, "memoray");
  assert.ok(Array.isArray(manifest.endpoints) && manifest.endpoints.length > 0);
  assert.ok(Array.isArray(manifest.process_map) && manifest.process_map.length > 0);
  assert.ok(manifest.data_model && manifest.config_surface && manifest.conformance);

  // The hotFiles contract must declare fileName/filePath — the field-drift
  // guard for the heatmap "Unknown File" regression.
  const overview = manifest.endpoints.find((e) => e.id === "beta_overview");
  assert.ok(overview, "beta_overview endpoint declared");
  const hotItems = overview.contract.hotFiles.items;
  assert.equal(hotItems.fileName, "string");
  assert.equal(hotItems.filePath, "string");

  // Every process-map node has an owner path.
  for (const node of manifest.process_map) {
    assert.ok(node.owner && node.owner.path, `process node ${node.id} must declare an owner`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
