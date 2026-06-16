// Decentralized app-registry port resolver (shell/orchestrator side).
//
// The binary16 app registry is three lightweight, standard-shaped files:
//
//   • aamp.app/1     — each repo's app.manifest.json self-describes itself
//                      (id, name, repo, role, requires, provides{port...},
//                      artifacts). The decentralized source of truth: an app
//                      owns its own descriptor (the .well-known / DID-document
//                      analogue).
//   • aamp.registry/1 — apps.registry.json at the parent deployment root only
//                      *references* members by id + path (the docker-compose /
//                      pnpm-workspace analogue). No app owns the others.
//   • aamp.lock/1    — apps.lock.json, generated here: the resolved {host,
//                      port, url} per service (the package-lock analogue,
//                      machine-local, git-ignored).
//
// This module reads the registry, resolves each member's preferred port into a
// free port (auto-bumping within portRange on a clash), and writes the lock so
// peer apps discover each other instead of hard-coding ports. Hierarchy is the
// `requires` DAG: services resolve before the shells that depend on them.
//
// It verifies each descriptor's HMAC signature when present (reusing
// manifest_signing.js) and warns — but does not hard-fail — on a missing or
// invalid signature, so the registry works before the first signing pass and
// never blocks local boot. The audit script (scripts/audit-registry.mjs) is
// the strict gate.

import fs from "node:fs";
import path from "node:path";
import net from "node:net";

import { verifyManifest } from "./manifest_signing.js";

export const REGISTRY_FILENAME = "apps.registry.json";
export const LOCK_FILENAME = "apps.lock.json";
export const APP_MANIFEST_FILENAME = "app.manifest.json";
export const REGISTRY_SCHEMA = "aamp.registry/1";
export const APP_SCHEMA = "aamp.app/1";
export const LOCK_SCHEMA = "aamp.lock/1";

export const DEFAULT_HOST = "127.0.0.1";

/**
 * Locate apps.registry.json: $BINARY16_REGISTRY_DIR first, else the nearest
 * one walking up from startDir. Returns an absolute path or null.
 */
export function findRegistry(startDir = process.cwd(), env = process.env) {
  const override = env.BINARY16_REGISTRY_DIR && String(env.BINARY16_REGISTRY_DIR).trim();
  if (override) {
    const candidate = path.join(path.resolve(override), REGISTRY_FILENAME);
    return fs.existsSync(candidate) ? candidate : null;
  }

  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, REGISTRY_FILENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Load the registry and every member's app descriptor.
 * Returns { registryDir, registryPath, registry, apps: [{ member, manifest,
 * manifestPath, warnings }] }.
 */
export function loadRegistry(startDir = process.cwd(), env = process.env) {
  const registryPath = findRegistry(startDir, env);
  if (!registryPath) {
    throw new Error(
      `No ${REGISTRY_FILENAME} found (looked up from ${path.resolve(startDir)} or $BINARY16_REGISTRY_DIR).`
    );
  }
  const registryDir = path.dirname(registryPath);
  const registry = readJson(registryPath);
  if (registry.schema !== REGISTRY_SCHEMA) {
    throw new Error(`${registryPath}: expected schema "${REGISTRY_SCHEMA}", got "${registry.schema}".`);
  }
  if (!Array.isArray(registry.members)) {
    throw new Error(`${registryPath}: "members" must be an array.`);
  }

  const apps = [];
  for (const member of registry.members) {
    const warnings = [];
    const manifestPath = path.resolve(registryDir, member.path, APP_MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) {
      warnings.push(`missing ${APP_MANIFEST_FILENAME} at ${manifestPath}`);
      apps.push({ member, manifest: null, manifestPath, warnings });
      continue;
    }
    let manifest;
    try {
      manifest = readJson(manifestPath);
    } catch (error) {
      warnings.push(`unparseable descriptor: ${error.message}`);
      apps.push({ member, manifest: null, manifestPath, warnings });
      continue;
    }
    if (manifest.schema !== APP_SCHEMA) {
      warnings.push(`expected schema "${APP_SCHEMA}", got "${manifest.schema}"`);
    }
    if (manifest.id !== member.id) {
      warnings.push(`registry id "${member.id}" != descriptor id "${manifest.id}"`);
    }
    if (manifest.signature) {
      if (!verifyManifest(manifest, manifest.signature, { env })) {
        warnings.push("signature does not verify (re-sign with scripts/audit-registry.mjs --sign)");
      }
    } else {
      warnings.push("descriptor is unsigned");
    }
    apps.push({ member, manifest, manifestPath, warnings });
  }

  return { registryDir, registryPath, registry, apps };
}

/**
 * Topologically order apps so every app's `requires` come before it
 * (services before the shells that consume them). Stable for unrelated apps.
 */
export function topoSortApps(apps) {
  const byId = new Map(apps.map((a) => [a.member.id, a]));
  const ordered = [];
  const seen = new Set();
  const visiting = new Set();

  function visit(app) {
    const id = app.member.id;
    if (seen.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`Dependency cycle in registry involving "${id}".`);
    }
    visiting.add(id);
    const requires = (app.manifest && Array.isArray(app.manifest.requires)) ? app.manifest.requires : [];
    for (const depId of requires) {
      const dep = byId.get(depId);
      if (dep) {
        visit(dep);
      }
    }
    visiting.delete(id);
    seen.add(id);
    ordered.push(app);
  }

  for (const app of apps) {
    visit(app);
  }
  return ordered;
}

/**
 * True if nothing is currently listening on host:port (the resolver can
 * assign it). Best-effort: a transient bind we immediately release.
 */
export function isPortFree(port, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

/**
 * Resolve a single provided service's port: prefer preferredPort, else the
 * first free port within portRange that has not already been claimed.
 */
async function resolveServicePort(provide, host, claimed) {
  const preferred = Number(provide.preferredPort);
  const [lo, hi] = Array.isArray(provide.portRange) && provide.portRange.length === 2
    ? provide.portRange.map(Number)
    : [preferred, preferred];

  const candidates = [preferred];
  for (let p = lo; p <= hi; p += 1) {
    if (p !== preferred) {
      candidates.push(p);
    }
  }

  for (const port of candidates) {
    if (claimed.has(port)) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port, host)) {
      claimed.add(port);
      return port;
    }
  }
  throw new Error(
    `No free port for ${provide.service} in range [${lo}, ${hi}] (all occupied or claimed).`
  );
}

/**
 * Resolve ports for every member service and (optionally) write the lockfile.
 * Returns { lock, registryDir, lockPath, warnings }.
 */
export async function resolvePorts({ startDir = process.cwd(), env = process.env, host = DEFAULT_HOST, write = true } = {}) {
  const { registryDir, registry, apps } = loadRegistry(startDir, env);
  const ordered = topoSortApps(apps);

  const services = {};
  const warnings = [];
  const claimed = new Set();

  for (const app of ordered) {
    for (const warning of app.warnings) {
      warnings.push(`${app.member.id}: ${warning}`);
    }
    const provides = (app.manifest && Array.isArray(app.manifest.provides)) ? app.manifest.provides : [];
    for (const provide of provides) {
      const port = await resolveServicePort(provide, host, claimed);
      const url = `http://${host}:${port}`;
      services[`${app.member.id}/${provide.service}`] = {
        appId: app.member.id,
        service: provide.service,
        host,
        port,
        url,
        health: provide.health || null,
        baseUrlVar: provide.baseUrlVar || null
      };
    }
  }

  const lock = {
    schema: LOCK_SCHEMA,
    registry: registry.name || "binary16",
    generatedAt: new Date().toISOString(),
    services
  };

  const lockPath = path.join(registryDir, LOCK_FILENAME);
  if (write) {
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
  }

  return { lock, registryDir, lockPath, warnings };
}
