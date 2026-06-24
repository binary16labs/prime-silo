#!/usr/bin/env node
// Conformance audit (and signer) for the decentralized app registry.
//
//   node scripts/audit-registry.mjs            # audit, exit 1 on drift
//   node scripts/audit-registry.mjs --json     # machine-readable report
//   node scripts/audit-registry.mjs --sign     # (re)sign every app.manifest.json
//                                              # (HMAC via BENNY_HMAC_KEY;
//                                              # deliberate human/CI step)
//
// Sibling of scripts/audit-integrations.mjs: same signing technique
// (server/lib/manifest_signing.js), same exit-code-as-gate contract. Validates:
//   • each member app.manifest.json: schema, id matches the registry, signature
//   • the `requires` DAG resolves to known members (no dangling deps)
//   • apps.lock.json (when present): schema, every service maps to a real
//     provided service, and no two services share a port

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadRegistry, APP_SCHEMA } from "../server/lib/registry_resolver.js";
import { readLock } from "../server/lib/registry_lock.js";
import { signManifest, verifyManifest } from "../server/lib/manifest_signing.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

function fail(message) {
  console.error(message);
  process.exit(1);
}

let loaded;
try {
  loaded = loadRegistry(projectRoot);
} catch (error) {
  fail(`registry audit failed: ${error.message}`);
}

const { registryPath, apps } = loaded;

if (args.has("--sign")) {
  let signedCount = 0;
  for (const app of apps) {
    if (!app.manifest) {
      console.error(`SKIP ${app.member.id}: no parseable descriptor at ${app.manifestPath}`);
      continue;
    }
    app.manifest.signature = signManifest(app.manifest);
    fs.writeFileSync(app.manifestPath, JSON.stringify(app.manifest, null, 2) + "\n", "utf8");
    console.log(`signed ${app.member.id} (${app.manifest.signature.value.slice(0, 12)}…)`);
    signedCount += 1;
  }
  console.log(`Signed ${signedCount} app descriptor(s).`);
  process.exit(0);
}

const findings = [];
function record(check, subject, status, detail) {
  findings.push({ check, subject, status, detail });
}

const memberIds = new Set(apps.map((a) => a.member.id));

for (const app of apps) {
  const id = app.member.id;
  if (!app.manifest) {
    record("descriptor", id, "drift", `missing/unparseable at ${app.manifestPath}`);
    continue;
  }
  record(
    "schema",
    id,
    app.manifest.schema === APP_SCHEMA ? "pass" : "drift",
    app.manifest.schema === APP_SCHEMA ? APP_SCHEMA : `got "${app.manifest.schema}"`
  );
  record(
    "id",
    id,
    app.manifest.id === id ? "pass" : "drift",
    app.manifest.id === id ? id : `descriptor id "${app.manifest.id}"`
  );
  record(
    "signature",
    id,
    app.manifest.signature && verifyManifest(app.manifest, app.manifest.signature)
      ? "pass"
      : "drift",
    app.manifest.signature ? "HMAC-SHA256" : "unsigned"
  );

  const requires = Array.isArray(app.manifest.requires) ? app.manifest.requires : [];
  for (const depId of requires) {
    record(
      "requires",
      `${id}->${depId}`,
      memberIds.has(depId) ? "pass" : "drift",
      memberIds.has(depId) ? "resolved" : "dangling dependency"
    );
  }
}

// Lockfile consistency (optional — only when a lock has been generated).
const lock = readLock(projectRoot);
if (lock) {
  const providedKeys = new Set();
  for (const app of apps) {
    const provides = (app.manifest && app.manifest.provides) || [];
    for (const provide of provides) {
      providedKeys.add(`${app.member.id}/${provide.service}`);
    }
  }
  const seenPorts = new Map();
  for (const [key, svc] of Object.entries(lock.services)) {
    record(
      "lock_service",
      key,
      providedKeys.has(key) ? "pass" : "drift",
      providedKeys.has(key) ? `:${svc.port}` : "service not declared by any app"
    );
    if (seenPorts.has(svc.port)) {
      record("lock_port", key, "drift", `port ${svc.port} also used by ${seenPorts.get(svc.port)}`);
    } else {
      seenPorts.set(svc.port, key);
    }
  }
} else {
  record("lock", "apps.lock.json", "skip", "not generated yet (run `node space registry resolve`)");
}

const driftCount = findings.filter((f) => f.status === "drift").length;
const report = {
  schema: "aamp.registry_audit/1",
  registry: registryPath,
  generatedAt: new Date().toISOString(),
  driftCount,
  findings
};

if (args.has("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Registry audit: ${registryPath}`);
  for (const f of findings) {
    const marker = f.status === "pass" ? "ok " : f.status === "drift" ? "DRIFT" : "skip";
    console.log(`  [${marker}] ${f.check} ${f.subject}: ${f.detail}`);
  }
  console.log(driftCount === 0 ? "No drift." : `${driftCount} drift finding(s).`);
}

process.exit(driftCount === 0 ? 0 : 1);
