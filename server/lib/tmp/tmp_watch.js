import fs from "node:fs";
import path from "node:path";

import { SERVER_TMP_DIR } from "../../config.js";

const TMP_ENTRY_MAX_AGE_MS = 25 * 60 * 1000;
const TMP_SWEEP_INTERVAL_MS = 60 * 1000;

function readEntryStats(entryPath) {
  try {
    return fs.lstatSync(entryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function shouldPreserveEntry(entryName) {
  return entryName === ".gitignore";
}

function removeTmpEntry(entryPath, stats) {
  fs.rmSync(entryPath, {
    force: true,
    recursive: stats?.isDirectory() === true
  });
}

function ensureServerTmpDir(tmpDir = SERVER_TMP_DIR) {
  const resolvedTmpDir = path.resolve(String(tmpDir || SERVER_TMP_DIR));
  fs.mkdirSync(resolvedTmpDir, { recursive: true });
  return resolvedTmpDir;
}

function sweepTmpDir(options = {}) {
  const tmpDir = ensureServerTmpDir(options.tmpDir);
  const maxAgeMs = normalizePositiveNumber(options.maxAgeMs, TMP_ENTRY_MAX_AGE_MS);
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const removedEntries = [];

  for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    if (shouldPreserveEntry(entry.name)) {
      continue;
    }

    const entryPath = path.join(tmpDir, entry.name);
    const stats = readEntryStats(entryPath);

    if (!stats) {
      continue;
    }

    if (nowMs - Number(stats.mtimeMs || 0) < maxAgeMs) {
      continue;
    }

    removeTmpEntry(entryPath, stats);
    removedEntries.push(entry.name);
  }

  return {
    removedEntries,
    tmpDir
  };
}

function createTmpWatch(options = {}) {
  const tmpDir = ensureServerTmpDir(options.tmpDir);
  const maxAgeMs = normalizePositiveNumber(options.maxAgeMs, TMP_ENTRY_MAX_AGE_MS);
  const sweepIntervalMs = normalizePositiveNumber(options.sweepIntervalMs, TMP_SWEEP_INTERVAL_MS);
  const onError =
    typeof options.onError === "function"
      ? options.onError
      : (error) => {
          console.error("Tmp cleanup failed.");
          console.error(error);
        };
  let intervalId = null;

  function runSweep() {
    try {
      return sweepTmpDir({
        maxAgeMs,
        nowMs: Date.now(),
        tmpDir
      });
    } catch (error) {
      onError(error);
      return {
        removedEntries: [],
        tmpDir
      };
    }
  }

  return {
    maxAgeMs,
    sweepIntervalMs,
    tmpDir,
    start() {
      if (intervalId) {
        return;
      }

      runSweep();
      intervalId = setInterval(runSweep, sweepIntervalMs);
      intervalId.unref?.();
    },
    stop() {
      if (!intervalId) {
        return;
      }

      clearInterval(intervalId);
      intervalId = null;
    },
    sweepNow() {
      return sweepTmpDir({
        maxAgeMs,
        nowMs: Date.now(),
        tmpDir
      });
    }
  };
}

export {
  TMP_ENTRY_MAX_AGE_MS,
  TMP_SWEEP_INTERVAL_MS,
  createTmpWatch,
  ensureServerTmpDir,
  sweepTmpDir
};
