// Decentralized app-registry lockfile reader (shell side).
//
// The binary16 app registry resolves every member app's preferred port into a
// machine-local lockfile (schema aamp.lock/1) so peer apps discover each other
// instead of hard-coding ports. This module is the read-only consumer the
// prime-silo shell uses to learn where memo-ray (and any future service)
// actually listens. The resolver that *writes* the lock lives in
// scripts/registry/resolve-ports.mjs.
//
// Discovery order for the lockfile:
//   1. $BINARY16_REGISTRY_DIR/apps.lock.json (explicit deployment override)
//   2. the nearest apps.lock.json walking up from the start dir (the parent
//      "binary16/" deployment root sits one level above each repo)
//
// Everything is best-effort: a missing or malformed lock returns null so every
// caller falls back to its own default. The registry is an optimisation, never
// a hard dependency — apps must still run standalone.

import fs from "node:fs";
import path from "node:path";

export const LOCK_FILENAME = "apps.lock.json";
export const LOCK_SCHEMA = "aamp.lock/1";

/**
 * Locate apps.lock.json. Returns an absolute path or null.
 */
export function findLockfile(startDir = process.cwd(), env = process.env) {
  const override = env.BINARY16_REGISTRY_DIR && String(env.BINARY16_REGISTRY_DIR).trim();
  if (override) {
    const candidate = path.join(path.resolve(override), LOCK_FILENAME);
    return fs.existsSync(candidate) ? candidate : null;
  }

  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, LOCK_FILENAME);
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

/**
 * Read and parse the lockfile. Returns the parsed object or null.
 */
export function readLock(startDir = process.cwd(), env = process.env) {
  const lockPath = findLockfile(startDir, env);
  if (!lockPath) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (parsed && parsed.schema === LOCK_SCHEMA && parsed.services && typeof parsed.services === "object") {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve the base URL a peer app/service was assigned, e.g.
 * lockServiceUrl({ appId: "memo-ray", service: "memory-graph" }).
 * Returns the trimmed URL string or null.
 */
export function lockServiceUrl({ appId, service, startDir = process.cwd(), env = process.env } = {}) {
  const lock = readLock(startDir, env);
  if (!lock) {
    return null;
  }
  const entry = lock.services[`${appId}/${service}`];
  if (entry && typeof entry.url === "string" && entry.url.trim()) {
    return entry.url.trim().replace(/\/+$/, "");
  }
  return null;
}
