#!/usr/bin/env node
// Phase M1 — headless integration conformance audit (and manifest signer).
//
//   node scripts/audit-integrations.mjs            # audit, exit 1 on drift
//   node scripts/audit-integrations.mjs --json     # raw aamp.audit_report/1
//   node scripts/audit-integrations.mjs --sign     # re-sign every manifest
//                                                  # (HMAC via BENNY_HMAC_KEY;
//                                                  # deliberate human step)
//
// Same audit implementation the shell serves at GET /api/integration_audit
// and the CLI exposes as `node space memory audit` — one source of truth.
// CI and headless maintaining agents (e.g. a Lemonade-driven local model)
// call this script; the exit code is the gate.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runIntegrationAudit, loadIntegrationManifests } from "../server/lib/integration_audit.js";
import { signManifest } from "../server/lib/manifest_signing.js";
import { createRuntimeParams } from "../server/lib/utils/runtime_params.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

function printFinding(finding) {
  const marker = finding.status === "pass" ? "ok " : finding.status === "drift" ? "DRIFT" : "skip";
  const ownerHint = finding.owner?.path
    ? `  -> ${finding.owner.repo}/${finding.owner.path}`
    : Array.isArray(finding.owners) && finding.owners.length
      ? `  -> ${finding.owners.map((owner) => `${owner.repo}/${owner.path}`).join(", ")}`
      : "";
  console.log(`  [${marker}] ${finding.check} ${finding.subject}: ${finding.detail}${ownerHint}`);
}

if (args.has("--sign")) {
  const loaded = await loadIntegrationManifests(projectRoot);
  if (loaded.length === 0) {
    console.error("No integration manifests found under manifests/integrations/.");
    process.exit(1);
  }
  for (const entry of loaded) {
    if (!entry.manifest) {
      console.error(`SKIP ${entry.filename}: does not parse (${entry.parseError})`);
      continue;
    }
    entry.manifest.signature = signManifest(entry.manifest);
    const filePath = path.join(projectRoot, "manifests", "integrations", entry.filename);
    await fs.writeFile(filePath, JSON.stringify(entry.manifest, null, 2) + "\n", "utf8");
    console.log(
      `signed ${entry.filename} (${entry.manifest.signature.value.slice(0, 12)}…, ${entry.manifest.signature.signed_at})`
    );
  }
  process.exit(0);
}

const runtimeParams = await createRuntimeParams(projectRoot);
const report = await runIntegrationAudit({ projectRoot, runtimeParams });

if (args.has("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const integration of report.integrations) {
    console.log(
      `${integration.id}: ${integration.status.toUpperCase()} (pass ${integration.summary.pass} / drift ${integration.summary.drift} / skipped ${integration.summary.skipped})`
    );
    for (const finding of integration.findings) {
      if (args.has("--verbose") || finding.status !== "pass") {
        printFinding(finding);
      }
    }
  }
  console.log(`overall: ${report.status.toUpperCase()}`);
}

process.exit(report.status === "drift" ? 1 : 0);
