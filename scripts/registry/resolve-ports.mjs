#!/usr/bin/env node
// Resolve every binary16 app's port into a free, non-clashing port and write
// apps.lock.json. Thin wrapper over server/lib/registry_resolver.js so launch
// scripts (scripts/dev.ps1, scripts/memoray.ps1) and CI can call one entry
// point. `node space registry resolve` is the same logic for operators.
//
//   node scripts/registry/resolve-ports.mjs            # resolve + write lock
//   node scripts/registry/resolve-ports.mjs --print    # also print the lock

import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePorts } from "../../server/lib/registry_resolver.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

try {
  const { lock, lockPath, warnings } = await resolvePorts({ startDir: projectRoot });
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  console.log(`Resolved ${Object.keys(lock.services).length} service(s) -> ${lockPath}`);
  for (const [key, svc] of Object.entries(lock.services)) {
    console.log(`  ${key.padEnd(28)} ${svc.url}`);
  }
  if (process.argv.includes("--print")) {
    console.log(JSON.stringify(lock, null, 2));
  }
} catch (error) {
  console.error(`registry resolve failed: ${error.message}`);
  process.exit(1);
}
