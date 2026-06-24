// LocalDiskStorageProvider — the default StorageProvider.
//
// Backs the StorageProvider contract with node:fs against the local filesystem,
// preserving exactly today's customware behaviour (writes land under
// CUSTOMWARE_PATH on disk). This is the provider in effect unless STORAGE_PROVIDER
// selects another (see factory.js).

import fs from "node:fs/promises";
import path from "node:path";

/**
 * @returns {import("./storage_provider.js").StorageProvider}
 */
export function createLocalDiskStorageProvider() {
  return {
    kind: "local",

    async readFile(filePath) {
      return fs.readFile(filePath);
    },

    async writeFile(filePath, data) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data);
    },

    async exists(filePath) {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },

    async stat(filePath) {
      const s = await fs.stat(filePath);
      return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
    },

    async list(dirPath) {
      return fs.readdir(dirPath);
    },

    async mkdir(dirPath) {
      await fs.mkdir(dirPath, { recursive: true });
    },

    // `force: false` makes a missing target an error (ENOENT), matching the
    // customware delete semantics; pass `force: true` for idempotent removal.
    async remove(targetPath, { recursive = true, force = false } = {}) {
      await fs.rm(targetPath, { recursive, force });
    },

    // `errorOnExist: true` refuses to clobber an existing destination (the
    // customware copy semantics). fs.cp rejects errorOnExist + force together,
    // so force mirrors the inverse.
    async copy(src, dst, { recursive = true, errorOnExist = false } = {}) {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.cp(src, dst, { recursive, errorOnExist, force: !errorOnExist });
    },

    async move(src, dst, { recursive = true } = {}) {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      try {
        await fs.rename(src, dst);
      } catch (error) {
        if (error?.code !== "EXDEV") {
          throw error;
        }
        // Cross-device move: rename can't span volumes, so copy then remove.
        await fs.cp(src, dst, { recursive, errorOnExist: true, force: false });
        await fs.rm(src, { recursive, force: false });
      }
    }
  };
}
