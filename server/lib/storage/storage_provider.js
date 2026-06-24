// StorageProvider — the abstraction over where L1/L2 customware state lives.
//
// Today every customware write in server/lib/customware/ calls node:fs directly
// against CUSTOMWARE_PATH on local disk. That couples horizontal scaling of the
// (otherwise stateless) shell to a shared filesystem: run two replicas without
// a shared/HA volume and their L1/L2 state forks (split-brain).
//
// This interface is the seam that breaks that coupling. A provider maps a
// logical absolute path to durable bytes; the default LocalDiskStorageProvider
// keeps today's behaviour, while an S3- or database-backed provider can serve a
// multi-replica deployment without a shared mount. See architecture/ADR-003 and
// the customware AGENTS.md for the migration plan.
//
// The contract is intentionally ASYNC even though the current callers are
// synchronous: object stores and databases cannot be served synchronously, so
// the long-term shape must be promise-based. Adopting a provider in
// file_access.js therefore means converting its write paths to async — that
// conversion is the bulk of the migration and is deliberately staged, not done
// blindly here.

/**
 * @typedef {Object} StorageStat
 * @property {number} size        Size in bytes.
 * @property {number} mtimeMs     Last-modified time, epoch ms.
 * @property {boolean} isDirectory
 */

/**
 * The provider contract. Implementations operate on absolute logical paths;
 * non-filesystem backends map a path to a key (typically under a configured
 * prefix). All methods reject on failure except `exists`, which resolves false.
 *
 * @typedef {Object} StorageProvider
 * @property {string} kind                                  Stable id, e.g. "local".
 * @property {(path: string) => Promise<Buffer>} readFile
 * @property {(path: string, data: Buffer|string) => Promise<void>} writeFile  Creates parent dirs.
 * @property {(path: string) => Promise<boolean>} exists
 * @property {(path: string) => Promise<StorageStat>} stat
 * @property {(dirPath: string) => Promise<string[]>} list  Entry names (not full paths).
 * @property {(path: string) => Promise<void>} mkdir         Recursive.
 * @property {(path: string, opts?: {recursive?: boolean, force?: boolean}) => Promise<void>} remove  `force:false` (default) errors when the target is absent.
 * @property {(src: string, dst: string, opts?: {recursive?: boolean, errorOnExist?: boolean}) => Promise<void>} copy  `errorOnExist:true` refuses to clobber an existing destination.
 * @property {(src: string, dst: string, opts?: {recursive?: boolean}) => Promise<void>} move  Falls back to copy+remove across devices.
 */

export const STORAGE_PROVIDER_METHODS = Object.freeze([
  "readFile",
  "writeFile",
  "exists",
  "stat",
  "list",
  "mkdir",
  "remove",
  "copy",
  "move"
]);

/**
 * Throw if `provider` does not satisfy the StorageProvider contract. Useful for
 * validating a custom provider wired in via configuration.
 *
 * @param {unknown} provider
 * @returns {StorageProvider}
 */
export function assertStorageProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new TypeError("StorageProvider must be an object.");
  }
  for (const method of STORAGE_PROVIDER_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new TypeError(`StorageProvider is missing required method: ${method}().`);
    }
  }
  return /** @type {StorageProvider} */ (provider);
}
