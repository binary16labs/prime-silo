#!/usr/bin/env node
//
// Phase M1 — integration audit tests.
//
// Exercises the contract validator and the audit engine against a stubbed
// fetchEndpoint: a pass case (live payloads match the manifest) and a drift
// case (a mutated payload → a finding that names the changed field and the
// owner path).

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateContract, auditIntegration } from "../server/lib/integration_audit.js";
import { signManifest } from "../server/lib/manifest_signing.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = { BENNY_HMAC_KEY: "ab".repeat(32) };

function paramsStub(names) {
  const set = new Set(names);
  return { getEntry: (n) => (set.has(n) ? { value: true, source: "stored" } : null) };
}

// A small manifest exercising every check, owners limited to prime-silo so
// the on-disk owner check finds real files.
function buildManifest() {
  return {
    schema: "aamp.integration/1",
    id: "test-integration",
    conformance: {
      checks: ["signature", "config_surface", "health", "payload_contracts", "owners"]
    },
    config_surface: {
      MEMORAY_ENABLED: { kind: "runtime_param" },
      MEMORAY_BASE_URL: { kind: "runtime_param" }
    },
    endpoints: [
      {
        id: "overview",
        method: "GET",
        path: "/beta/overview",
        contract: {
          totalNodes: "number",
          hotFiles: {
            type: "array",
            items: { fileName: "string", filePath: "string", count: "number" }
          }
        }
      }
    ],
    process_map: [
      {
        id: "api",
        health: { endpoint: "overview", expect: "totalNodes" },
        owner: { repo: "prime-silo", path: "server/lib/memoray_proxy.js" }
      },
      {
        id: "widget",
        consumes: ["overview"],
        owner: {
          repo: "prime-silo",
          path: "app/L0/_all/mod/_prime_silo/widgets/memoray/overview_cards/index.js"
        }
      }
    ]
  };
}

async function main() {
  testValidateContractPrimitivesAndOptionals();
  testValidateContractArrayItems();
  testValidateContractHandlesTypeNamedField();
  testValidateContractCatchesFieldRename();
  await testAuditPass();
  await testAuditDriftOnContract();
  await testAuditUnsignedManifestDrifts();
  console.log("integration_audit_test: ok");
}

function testValidateContractPrimitivesAndOptionals() {
  assert.deepEqual(validateContract({ a: 1 }, { a: "number" }), []);
  assert.deepEqual(validateContract({}, { a: "number?" }), [], "optional missing field is fine");
  const m = validateContract({}, { a: "number" });
  assert.equal(m.length, 1);
  assert.match(m[0], /a: missing/);
  assert.deepEqual(validateContract("x", "string|number"), []);
  assert.equal(validateContract(true, "string|number").length, 1);
}

function testValidateContractArrayItems() {
  const contract = { type: "array", items: { fileName: "string" } };
  assert.deepEqual(validateContract([{ fileName: "a.js" }], contract), []);
  assert.deepEqual(validateContract([], contract), [], "empty array passes (no sample to check)");
  const m = validateContract([{ path: "a.js" }], contract);
  assert.equal(m.length, 1);
  assert.match(m[0], /\[0\]\.fileName: missing/);
}

function testValidateContractHandlesTypeNamedField() {
  // Entity payloads carry a field literally named "type". A field map that
  // contains it must NOT be misread as a composite { type: ... } spec.
  const sessionItem = { id: "string", type: "string", agent: "string" };
  assert.deepEqual(
    validateContract({ id: "x", type: "Session", agent: "Claude" }, sessionItem),
    [],
    "field map with a `type` field validates by fields, not as a typed value"
  );
  // As array items, too (the /sessions contract shape).
  assert.deepEqual(
    validateContract([{ id: "x", type: "Session", agent: "Claude" }], {
      type: "array",
      items: sessionItem
    }),
    []
  );
  // A real composite (type + items/fields) is still treated as composite.
  const m = validateContract("nope", { type: "array", items: { id: "string" } });
  assert.equal(m.length, 1);
  assert.match(m[0], /expected array/);
}

function testValidateContractCatchesFieldRename() {
  // The hotFiles fileName/filePath → path regression, declaratively caught.
  const contract = { type: "array", items: { fileName: "string", filePath: "string" } };
  const mismatches = validateContract([{ path: "x", count: 3 }], contract);
  assert.ok(mismatches.some((m) => /fileName: missing/.test(m)));
  assert.ok(mismatches.some((m) => /filePath: missing/.test(m)));
}

const GOOD_OVERVIEW = {
  totalNodes: 10,
  hotFiles: [{ fileName: "a.js", filePath: "C:/a.js", count: 3 }]
};

async function testAuditPass() {
  const manifest = buildManifest();
  manifest.signature = signManifest(manifest, { env: ENV });
  const report = await auditIntegration(manifest, {
    projectRoot,
    runtimeParams: paramsStub(["MEMORAY_ENABLED", "MEMORAY_BASE_URL"]),
    env: ENV,
    fetchEndpoint: async () => ({ ok: true, status: 200, body: GOOD_OVERVIEW })
  });
  assert.equal(report.status, "pass", JSON.stringify(report.findings, null, 2));
  assert.equal(report.summary.drift, 0);
  assert.ok(report.findings.some((f) => f.check === "signature" && f.status === "pass"));
  assert.ok(report.findings.some((f) => f.check === "payload_contracts" && f.status === "pass"));
  assert.ok(report.findings.some((f) => f.check === "owners" && f.status === "pass"));
}

async function testAuditDriftOnContract() {
  const manifest = buildManifest();
  manifest.signature = signManifest(manifest, { env: ENV });
  // Upstream renamed fileName/filePath → path (the regression).
  const drifted = { totalNodes: 10, hotFiles: [{ path: "C:/a.js", count: 3 }] };
  const report = await auditIntegration(manifest, {
    projectRoot,
    runtimeParams: paramsStub(["MEMORAY_ENABLED", "MEMORAY_BASE_URL"]),
    env: ENV,
    fetchEndpoint: async () => ({ ok: true, status: 200, body: drifted })
  });
  assert.equal(report.status, "drift");
  const finding = report.findings.find(
    (f) => f.check === "payload_contracts" && f.status === "drift"
  );
  assert.ok(finding, "must report a payload_contracts drift");
  assert.match(finding.detail, /fileName/);
  // Finding carries the owner path(s) of the consumers so an agent can fix it.
  assert.ok(
    Array.isArray(finding.owners) && finding.owners.some((o) => o.path.includes("overview_cards"))
  );
}

async function testAuditUnsignedManifestDrifts() {
  const manifest = buildManifest(); // no signature attached
  const report = await auditIntegration(manifest, {
    projectRoot,
    runtimeParams: paramsStub(["MEMORAY_ENABLED", "MEMORAY_BASE_URL"]),
    env: ENV,
    fetchEndpoint: async () => ({ ok: true, status: 200, body: GOOD_OVERVIEW })
  });
  assert.equal(report.status, "drift");
  assert.ok(report.findings.some((f) => f.check === "signature" && f.status === "drift"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
