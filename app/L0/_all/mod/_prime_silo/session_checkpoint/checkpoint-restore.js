// ADR-001 Phase H — checkpoint restore + fork helpers.
//
// ``applyCheckpointRestore`` is the core restore path: given a full
// checkpoint object, it returns the restored history and re-loads skills.
// Transient-item re-staging uses ``space.api.fileRead`` when available; if
// the runtime API is not accessible, items are collected as warnings rather
// than aborting the restore.
//
// ``buildForkName`` is a pure function used by ``forkCheckpoint`` (in
// index.js) to compute the next fork name. Kept here so both sides of the
// fork flow (create + name) share the same logic.

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Apply a checkpoint to the current session.
 *
 * Does three things in order:
 *   1. Returns the restored history array (caller must swap their state).
 *   2. Re-invokes ``space.skills.load(id)`` for each skill in
 *      ``checkpoint.skills``. Errors are collected as warnings; a failed
 *      skill load does NOT abort the restore.
 *   3. Attempts to re-read each ``transient_items`` path via
 *      ``space.api.fileRead``. Missing/inaccessible paths are warnings.
 *
 * The function does NOT directly mutate any external state — it returns a
 * result object for the caller to apply. This keeps the restore path
 * testable without a live runtime.
 *
 * @param {object} checkpoint  Full aamp.checkpoint/1 object
 * @param {{ spaceApi?: object }} [options]
 *   ``spaceApi`` is injected for testing; live callers use ``globalThis.space``
 *   (the standard space-agent runtime API).
 * @returns {Promise<{
 *   restoredHistory: Array<{role: string, content: string}>,
 *   loadedSkills: string[],
 *   failedSkills: Array<{skill: string, error: string}>,
 *   restoredTransient: object,
 *   failedTransient: Array<{key: string, error: string}>,
 *   warnings: string[]
 * }>}
 */
export async function applyCheckpointRestore(checkpoint, options = {}) {
  const api = options.spaceApi || globalThis.space;
  const warnings = [];
  const failedSkills = [];
  const failedTransient = [];

  // 1. History
  const restoredHistory = Array.isArray(checkpoint.history) ? checkpoint.history : [];

  // 2. Skills
  const loadedSkills = [];
  for (const skillId of checkpoint.skills ?? []) {
    try {
      if (api && api.skills && typeof api.skills.load === "function") {
        await api.skills.load(skillId);
      }
      loadedSkills.push(skillId);
    } catch (err) {
      const msg = `Could not load skill "${skillId}": ${err && err.message ? err.message : String(err)}`;
      failedSkills.push({ skill: skillId, error: err && err.message ? err.message : String(err) });
      warnings.push(msg);
    }
  }

  // 3. Transient items — re-read referenced file paths
  const restoredTransient = {};
  for (const [key, item] of Object.entries(checkpoint.transient_items ?? {})) {
    try {
      if (api && api.api && typeof api.api.fileRead === "function" && item.path) {
        const content = await api.api.fileRead(item.path, item.encoding ?? "utf8");
        restoredTransient[key] = { ...item, content };
      } else {
        // No fileRead available — include item reference without content.
        restoredTransient[key] = { ...item };
        warnings.push(
          `Transient item "${key}": fileRead API not available, path reference preserved.`
        );
      }
    } catch (err) {
      const msg = `Could not re-stage transient item "${key}" (${item.path}): ${
        err && err.message ? err.message : String(err)
      }`;
      failedTransient.push({ key, error: err && err.message ? err.message : String(err) });
      warnings.push(msg);
    }
  }

  return {
    restoredHistory,
    loadedSkills,
    failedSkills,
    restoredTransient,
    failedTransient,
    warnings
  };
}

// ---------------------------------------------------------------------------
// Fork name helpers
// ---------------------------------------------------------------------------

/**
 * Compute the next fork name for a given base checkpoint name and an
 * existing list of checkpoint summaries.
 *
 * Examples:
 *   buildForkName("analysis-base", [])                   → "analysis-base_fork_1"
 *   buildForkName("analysis-base", [{name:"analysis-base_fork_1"}])
 *                                                          → "analysis-base_fork_2"
 *   buildForkName("x", [{name:"x_fork_1"}, {name:"x_fork_3"}])
 *                                                          → "x_fork_4"
 *
 * @param {string} baseName  The checkpoint to fork from
 * @param {Array<{name: string}>} existingCheckpoints  All checkpoints in the workspace
 * @returns {string} The new fork name
 */
export function buildForkName(baseName, existingCheckpoints) {
  const prefix = `${baseName}_fork_`;
  let maxIndex = 0;
  for (const cp of existingCheckpoints ?? []) {
    if (typeof cp.name === "string" && cp.name.startsWith(prefix)) {
      const suffix = cp.name.slice(prefix.length);
      const n = parseInt(suffix, 10);
      if (Number.isFinite(n) && n > maxIndex) {
        maxIndex = n;
      }
    }
  }
  return `${prefix}${maxIndex + 1}`;
}

/**
 * Build a system notice string to inject at the top of the restored session
 * so the operator (and the agent) know the session has been restored.
 *
 * @param {string} checkpointName
 * @returns {string}
 */
export function buildRestoreNotice(checkpointName) {
  return `Session restored from checkpoint "${checkpointName}".`;
}

/**
 * Build the auto-save name used before a restore (so the previous session can
 * be recovered if the restore was accidental).
 *
 * @returns {string}
 */
export function buildPreRestoreName() {
  const ts = new Date()
    .toISOString()
    .replace(/[T:]/g, "-")
    .replace(/\.\d+Z$/, "");
  return `pre-restore-${ts}`;
}

export const __testing = {
  buildForkName,
  buildRestoreNotice,
  buildPreRestoreName
};
