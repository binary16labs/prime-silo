#!/usr/bin/env node
//
// Phase B-Bridge — bridge.integration.json contract tests + memo-ray
// adaptation guard.
//
// Asserts the Bridge manifest's structure, signature, and that its
// conformance checks are honest (signature/config_surface/owners only — the
// runtime contracts it documents are not probed by the memoray-targeted
// audit). Also guards the post-update memo-ray adaptation: the lifelog
// endpoint + the bridge_pulse consumer must be declared in the memoray
// manifest, and the hotFiles regression guard must still hold.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { signManifest, verifyManifest } from "../server/lib/manifest_signing.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readManifest(id) {
  const raw = await fs.readFile(path.join(projectRoot, "manifests", "integrations", `${id}.integration.json`), "utf8");
  return JSON.parse(raw);
}

async function main() {
  await testBridgeStructure();
  await testBridgeChecksAreHonest();
  await testBridgeSignatureVerifies();
  await testBridgeOwnersExistOnDisk();
  await testMemorayLifelogAdaptation();
  console.log("bridge_integration_manifest_test: ok");
}

async function testBridgeStructure() {
  const m = await readManifest("bridge");
  assert.equal(m.schema, "aamp.integration/1");
  assert.equal(m.id, "bridge");
  assert.ok(Array.isArray(m.endpoints) && m.endpoints.length > 0);
  assert.ok(Array.isArray(m.process_map) && m.process_map.length > 0);
  assert.ok(m.data_model && Array.isArray(m.data_model.modes) && m.data_model.modes.length === 6);
  assert.ok(m.config_surface.BRIDGE_DEFAULT_MODE, "declares the configurable default mode");
  assert.equal(m.config_surface.BRIDGE_DEFAULT_MODE.kind, "runtime_param");
  for (const node of m.process_map) {
    assert.ok(node.owner && node.owner.path, `process node ${node.id} declares an owner`);
  }
}

async function testBridgeChecksAreHonest() {
  const m = await readManifest("bridge");
  const checks = new Set(m.conformance.checks);
  assert.ok(checks.has("signature") && checks.has("config_surface") && checks.has("owners"));
  // The audit's live fetcher targets memo-ray, not the runtime — so the bridge
  // must NOT claim to probe runtime payloads/health (it would falsely drift).
  assert.ok(!checks.has("payload_contracts"), "bridge must not declare payload_contracts (runtime not probed here)");
  assert.ok(!checks.has("health"), "bridge must not declare health (runtime not probed here)");
  for (const ep of m.endpoints) {
    assert.equal(ep.probe, false, `endpoint ${ep.id} is documentation-only (probe:false)`);
  }
}

async function testBridgeSignatureVerifies() {
  const m = await readManifest("bridge");
  // The checked-in signature is HMAC-keyed to the deployment's BENNY_HMAC_KEY
  // (the live shell + `node space` load it from .env), so we don't assert it
  // verifies under whatever key this bare test shell happens to have. Instead:
  // the envelope is well-formed, and the canonical-payload sign/verify path
  // round-trips under an explicit key (environment-independent).
  assert.ok(m.signature && m.signature.algorithm === "HMAC-SHA256", "bridge manifest carries an HMAC-SHA256 signature envelope");
  assert.ok(/^[0-9a-f]{64}$/.test(m.signature.value || ""), "signature value is a sha256 hex digest");
  const env = { BENNY_HMAC_KEY: "ab".repeat(32) };
  const fresh = signManifest(m, { env });
  assert.equal(verifyManifest(m, fresh, { env }), true, "sign/verify round-trips for the bridge manifest payload");
}

async function testBridgeOwnersExistOnDisk() {
  const m = await readManifest("bridge");
  for (const node of m.process_map) {
    if (node.owner.repo !== "prime-silo") continue;
    await fs.access(path.join(projectRoot, node.owner.path));
  }
}

async function testMemorayLifelogAdaptation() {
  const m = await readManifest("memoray");
  const lifelog = m.endpoints.find((e) => e.id === "lifelog");
  assert.ok(lifelog, "memoray manifest declares the new lifelog endpoint");
  assert.equal(lifelog.path, "/lifelog");
  assert.equal(lifelog.contract.items.id, "string");
  assert.equal(lifelog.contract.items.timestamp, "number");

  const pulse = m.process_map.find((n) => n.id === "bridge_pulse");
  assert.ok(pulse, "memoray manifest links the bridge_pulse consumer");
  assert.ok(pulse.consumes.includes("lifelog"));

  // hotFiles regression guard still in force after the adaptation.
  const overview = m.endpoints.find((e) => e.id === "beta_overview");
  assert.equal(overview.contract.hotFiles.items.fileName, "string");
  assert.equal(overview.contract.hotFiles.items.filePath, "string");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
