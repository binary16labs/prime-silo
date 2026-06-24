// StorageProvider factory + process-wide singleton.
//
// `getStorageProvider()` returns the active provider, selected once from the
// STORAGE_PROVIDER env var (default "local"). Customware code should depend on
// this module rather than node:fs directly so a deployment can swap the backing
// store without touching call sites — see ./AGENTS.md for the migration plan.

import { createLocalDiskStorageProvider } from "./local_disk_provider.js";
import { assertStorageProvider } from "./storage_provider.js";

export { assertStorageProvider, STORAGE_PROVIDER_METHODS } from "./storage_provider.js";
export { createLocalDiskStorageProvider } from "./local_disk_provider.js";

let _active = null;

/**
 * Build the configured provider. Currently only "local" ships; "s3" and "db"
 * are recognised names reserved for pluggable implementations and throw with
 * guidance until one is provided.
 *
 * @param {{ kind?: string }} [options]
 * @returns {import("./storage_provider.js").StorageProvider}
 */
export function createStorageProvider({ kind } = {}) {
  const selected = (kind || process.env.STORAGE_PROVIDER || "local").toLowerCase();

  switch (selected) {
    case "local":
      return createLocalDiskStorageProvider();
    case "s3":
    case "db":
      throw new Error(
        `STORAGE_PROVIDER="${selected}" is reserved but not yet implemented. ` +
          `Implement the StorageProvider contract (server/lib/storage/storage_provider.js) ` +
          `and register it here, or use "local" (the default).`
      );
    default:
      throw new Error(`Unknown STORAGE_PROVIDER="${selected}". Expected one of: local, s3, db.`);
  }
}

/**
 * Process-wide active provider, constructed lazily on first use.
 *
 * @returns {import("./storage_provider.js").StorageProvider}
 */
export function getStorageProvider() {
  if (!_active) {
    _active = assertStorageProvider(createStorageProvider());
  }
  return _active;
}

/**
 * Override the active provider (tests / embedding hosts). Pass null to reset so
 * the next getStorageProvider() rebuilds from configuration.
 *
 * @param {import("./storage_provider.js").StorageProvider | null} provider
 */
export function setStorageProvider(provider) {
  _active = provider ? assertStorageProvider(provider) : null;
}
