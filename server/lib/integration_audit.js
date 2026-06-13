// Phase M1 — integration conformance audit.
//
// Walks every manifest under manifests/integrations/*.integration.json and
// probes live reality against what the manifest declares. The output is a
// machine-readable drift report — the entry point for any maintaining agent
// (Claude, or a local LLM via Lemonade): each finding carries the owner
// path(s) where a fix should be drafted, so maintenance never starts with
// codebase spelunking.
//
// Checks (declared in the manifest's `conformance.checks`):
//   signature          — embedded HMAC envelope verifies (manifest_signing.js,
//                        same scheme as the runtime's .aamp.view signing)
//   config_surface     — declared runtime_param keys exist in commands/params.yaml
//   health             — process-map health probes answer with the expected field
//   payload_contracts  — one live sample per declared endpoint validates
//                        field-by-field against the declared contract (this is
//                        the check that catches silent API drift like the
//                        hotFiles fileName/filePath rename)
//   owners             — declared owner paths resolve on disk
//
// Reused by: server/api/integration_audit.js (HTTP), commands/memory.js
// (`node space memory audit`), scripts/audit-integrations.mjs (CI/headless).

import fs from "node:fs/promises";
import path from "node:path";

import { memorayRequest, resolveMemoraySettings } from "./memoray_proxy.js";
import { verifyManifest } from "./manifest_signing.js";
import { loadParamSpecs } from "./utils/runtime_params.js";

const INTEGRATIONS_DIR = path.join("manifests", "integrations");

export async function loadIntegrationManifests(projectRoot) {
  const dir = path.join(projectRoot, INTEGRATIONS_DIR);

  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const manifests = [];
  for (const filename of entries.filter((name) => name.endsWith(".integration.json")).sort()) {
    try {
      const raw = await fs.readFile(path.join(dir, filename), "utf8");
      manifests.push({ filename, manifest: JSON.parse(raw) });
    } catch (err) {
      manifests.push({ filename, manifest: null, parseError: String(err?.message || err) });
    }
  }
  return manifests;
}

/* ── contract validation ─────────────────────────────────────────────── */

function matchesType(value, typeName) {
  switch (typeName.trim()) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// A composite spec is { type: "array", items: <contract> } or
// { type: "object", fields: <field map> }. The `items`/`fields` companion is
// required to distinguish a composite from an ordinary field map that simply
// has a field literally named "type" (entity payloads do — every entity
// carries a `type` field). Without that guard, { id, type, agent } would be
// misread as "a value of type string".
function isCompositeSpec(spec) {
  return (
    Boolean(spec) &&
    typeof spec === "object" &&
    !Array.isArray(spec) &&
    typeof spec.type === "string" &&
    ("items" in spec || "fields" in spec)
  );
}

/**
 * Validate `value` against a declared contract. Contract grammar:
 *   "string" | "number" | "boolean" | "object" | "array"  (unions via "|")
 *   field names ending in "?" are optional
 *   { type: "array", items: <contract> }   validates the first element
 *   { type: "object", fields: <field map> }
 *   plain object = field map applied to an object value
 * Returns a list of mismatch strings ("hotFiles[0].fileName: expected string, got undefined").
 */
export function validateContract(value, contract, fieldPath = "$") {
  const mismatches = [];

  if (typeof contract === "string") {
    // A trailing "?" on the type string marks the field optional. The caller
    // only recurses here for present fields, so an absent optional is already
    // handled in the field-map branch; this guards a direct undefined too.
    const optional = contract.endsWith("?");
    const spec = optional ? contract.slice(0, -1) : contract;
    if (value === undefined && optional) {
      return mismatches;
    }
    if (!spec.split("|").some((typeName) => matchesType(value, typeName))) {
      mismatches.push(`${fieldPath}: expected ${contract}, got ${describeValue(value)}`);
    }
    return mismatches;
  }

  if (isCompositeSpec(contract)) {
    if (!matchesType(value, contract.type)) {
      mismatches.push(`${fieldPath}: expected ${contract.type}, got ${describeValue(value)}`);
      return mismatches;
    }
    if (contract.type === "array" && contract.items && value.length > 0) {
      mismatches.push(...validateContract(value[0], contract.items, `${fieldPath}[0]`));
    }
    if (contract.type === "object" && contract.fields) {
      mismatches.push(...validateContract(value, contract.fields, fieldPath));
    }
    return mismatches;
  }

  if (contract && typeof contract === "object") {
    // Plain field map over an object value.
    if (!matchesType(value, "object")) {
      mismatches.push(`${fieldPath}: expected object, got ${describeValue(value)}`);
      return mismatches;
    }
    for (const [name, subContract] of Object.entries(contract)) {
      // Optionality is encoded as a trailing "?" on the type string.
      const optional = typeof subContract === "string" && subContract.endsWith("?");
      if (!(name in value)) {
        if (!optional) {
          mismatches.push(`${fieldPath}.${name}: missing (expected ${typeof subContract === "string" ? subContract : subContract?.type || "object"})`);
        }
        continue;
      }
      mismatches.push(...validateContract(value[name], subContract, `${fieldPath}.${name}`));
    }
  }

  return mismatches;
}

/* ── audit checks ────────────────────────────────────────────────────── */

function ownersConsuming(manifest, endpointId) {
  return (manifest.process_map || [])
    .filter((node) => Array.isArray(node.consumes) && node.consumes.includes(endpointId))
    .map((node) => node.owner)
    .filter(Boolean);
}

function endpointById(manifest, endpointId) {
  return (manifest.endpoints || []).find((endpoint) => endpoint.id === endpointId) || null;
}

async function resolveSamplePathParams(endpoint, manifest, fetchEndpoint) {
  let resolvedPath = endpoint.path;
  for (const [paramName, source] of Object.entries(endpoint.sample_path_param || {})) {
    const sourceEndpoint = endpointById(manifest, source.endpoint);
    if (!sourceEndpoint) {
      return { skipped: `sample source endpoint "${source.endpoint}" not declared` };
    }
    const result = await fetchEndpoint(sourceEndpoint.path);
    if (!result.ok || !Array.isArray(result.body) || result.body.length === 0) {
      return { skipped: `no sample available from ${sourceEndpoint.path} to fill {${paramName}}` };
    }
    if (source.pick !== "first.id" || typeof result.body[0]?.id !== "string") {
      return { skipped: `unsupported sample pick "${source.pick}" for {${paramName}}` };
    }
    resolvedPath = resolvedPath.replace(`{${paramName}}`, encodeURIComponent(result.body[0].id));
  }
  return { path: resolvedPath };
}

async function pathExists(rootDir, relativePath) {
  try {
    await fs.access(path.join(rootDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

function resolveRepoRoot(repo, projectRoot, env = process.env) {
  if (repo === "prime-silo") {
    return projectRoot;
  }
  if (repo === "memo-ray") {
    return env.MEMORAY_DIR || path.join(projectRoot, "..", "memo-ray");
  }
  return null;
}

/**
 * Audit one integration manifest. Returns an aamp.audit_report/1 object.
 * `options.fetchEndpoint` is the injection seam for tests: (apiPath) =>
 * Promise<{ok, status, body}>; defaults to memorayRequest against the
 * resolved settings.
 */
export async function auditIntegration(manifest, options = {}) {
  const { projectRoot, runtimeParams, env = process.env } = options;
  const findings = [];
  const add = (check, status, subject, detail, extra = {}) => {
    findings.push({ check, status, subject, detail, ...extra });
  };

  const settings = await resolveMemoraySettings({ runtimeParams, projectRoot });
  const fetchEndpoint =
    options.fetchEndpoint ||
    ((apiPath) => memorayRequest(apiPath, { runtimeParams, projectRoot }));

  const declaredChecks = new Set(manifest?.conformance?.checks || []);

  // 1. signature
  if (declaredChecks.has("signature")) {
    if (!manifest.signature) {
      add("signature", "drift", manifest.id, "manifest is unsigned — sign it with scripts/audit-integrations.mjs --sign", {
        owner: { repo: "prime-silo", path: `manifests/integrations/${manifest.id}.integration.json` }
      });
    } else if (verifyManifest(manifest, manifest.signature, { env })) {
      add("signature", "pass", manifest.id, "embedded HMAC-SHA256 signature verifies");
    } else {
      add("signature", "drift", manifest.id, "embedded signature does NOT verify — manifest was edited after signing; re-sign after review", {
        owner: { repo: "prime-silo", path: `manifests/integrations/${manifest.id}.integration.json` }
      });
    }
  }

  // 2. config_surface
  if (declaredChecks.has("config_surface") && projectRoot) {
    let paramNames = new Set();
    try {
      paramNames = new Set((await loadParamSpecs(projectRoot)).map((spec) => spec.name));
    } catch (err) {
      add("config_surface", "drift", "commands/params.yaml", `could not load param specs: ${String(err?.message || err)}`);
    }
    for (const [key, spec] of Object.entries(manifest.config_surface || {})) {
      if (spec?.kind !== "runtime_param") {
        continue;
      }
      if (paramNames.has(key)) {
        add("config_surface", "pass", key, "declared runtime param exists in commands/params.yaml");
      } else {
        add("config_surface", "drift", key, "declared runtime param is missing from commands/params.yaml", {
          owner: { repo: "prime-silo", path: "commands/params.yaml" }
        });
      }
    }
  }

  // 3. health — establishes reachability for the contract checks below.
  let upstreamReachable = settings.enabled;
  if (declaredChecks.has("health")) {
    for (const node of manifest.process_map || []) {
      if (!node.health) {
        continue;
      }
      const endpoint = endpointById(manifest, node.health.endpoint);
      if (!endpoint) {
        add("health", "drift", node.id, `health endpoint "${node.health.endpoint}" is not declared in endpoints[]`, { owner: node.owner });
        continue;
      }
      if (!settings.enabled) {
        add("health", "skipped", node.id, "memoray is disabled (MEMORAY_ENABLED=false)");
        continue;
      }
      const result = await fetchEndpoint(endpoint.path);
      if (!result.ok) {
        upstreamReachable = false;
        add("health", "drift", node.id, result.error === "memoray_unreachable"
          ? `unreachable at ${settings.baseUrl} — ${result.hint || "boot memo-ray"}`
          : `health probe ${endpoint.path} returned status ${result.status}`, { owner: node.owner });
      } else if (node.health.expect && !(node.health.expect in (result.body || {}))) {
        add("health", "drift", node.id, `health response is missing expected field "${node.health.expect}"`, { owner: node.owner });
      } else {
        add("health", "pass", node.id, `health probe ${endpoint.path} ok`);
      }
    }
  }

  // 4. payload_contracts
  if (declaredChecks.has("payload_contracts")) {
    for (const endpoint of manifest.endpoints || []) {
      if (!endpoint.contract || endpoint.probe === false) {
        continue;
      }
      if (!settings.enabled || !upstreamReachable) {
        add("payload_contracts", "skipped", endpoint.id, settings.enabled
          ? "upstream unreachable — contract not evaluated (see health finding)"
          : "memoray is disabled — contract not evaluated");
        continue;
      }
      const resolved = await resolveSamplePathParams(endpoint, manifest, fetchEndpoint);
      if (resolved.skipped) {
        add("payload_contracts", "skipped", endpoint.id, resolved.skipped);
        continue;
      }
      const result = await fetchEndpoint(resolved.path);
      if (!result.ok) {
        add("payload_contracts", "drift", endpoint.id, `GET ${resolved.path} returned status ${result.status}`, {
          owners: ownersConsuming(manifest, endpoint.id)
        });
        continue;
      }
      const mismatches = validateContract(result.body, endpoint.contract);
      if (mismatches.length === 0) {
        add("payload_contracts", "pass", endpoint.id, `live payload matches the declared contract (${resolved.path})`);
      } else {
        add("payload_contracts", "drift", endpoint.id, `live payload drifted from the declared contract: ${mismatches.join("; ")}`, {
          expected: endpoint.contract,
          owners: ownersConsuming(manifest, endpoint.id)
        });
      }
    }
  }

  // 5. owners
  if (declaredChecks.has("owners") && projectRoot) {
    for (const node of manifest.process_map || []) {
      if (!node.owner?.path) {
        continue;
      }
      const repoRoot = resolveRepoRoot(node.owner.repo, projectRoot, env);
      if (!repoRoot) {
        add("owners", "skipped", node.id, `unknown owner repo "${node.owner.repo}"`);
        continue;
      }
      if (node.owner.repo === "memo-ray" && !(await pathExists(repoRoot, "."))) {
        add("owners", "skipped", node.id, "memo-ray checkout not found locally (set MEMORAY_DIR or clone beside prime-silo)");
        continue;
      }
      if (await pathExists(repoRoot, node.owner.path)) {
        add("owners", "pass", node.id, `${node.owner.repo}/${node.owner.path} exists`);
      } else {
        add("owners", "drift", node.id, `declared owner path ${node.owner.repo}/${node.owner.path} does not exist`, { owner: node.owner });
      }
    }
  }

  const drifted = findings.some((finding) => finding.status === "drift");
  return {
    schema: "aamp.audit_report/1",
    id: String(manifest.id || ""),
    status: drifted ? "drift" : "pass",
    checked_at: new Date().toISOString(),
    settings,
    summary: {
      pass: findings.filter((f) => f.status === "pass").length,
      drift: findings.filter((f) => f.status === "drift").length,
      skipped: findings.filter((f) => f.status === "skipped").length
    },
    findings
  };
}

/**
 * Audit every integration manifest in the project. Top-level status is
 * "drift" if any manifest drifts (or fails to parse).
 */
export async function runIntegrationAudit(options = {}) {
  const { projectRoot } = options;
  const loaded = await loadIntegrationManifests(projectRoot);
  const reports = [];

  for (const entry of loaded) {
    if (!entry.manifest) {
      reports.push({
        schema: "aamp.audit_report/1",
        id: entry.filename,
        status: "drift",
        checked_at: new Date().toISOString(),
        summary: { pass: 0, drift: 1, skipped: 0 },
        findings: [
          { check: "manifest", status: "drift", subject: entry.filename, detail: `manifest does not parse: ${entry.parseError}` }
        ]
      });
      continue;
    }
    reports.push(await auditIntegration(entry.manifest, options));
  }

  return {
    schema: "aamp.audit_report/1",
    status: reports.some((report) => report.status === "drift") ? "drift" : "pass",
    checked_at: new Date().toISOString(),
    integrations: reports
  };
}
