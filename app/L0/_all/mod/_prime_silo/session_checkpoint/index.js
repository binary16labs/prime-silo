// ADR-001 Phase H — session checkpoint public API.
//
// Public entry point for the session_checkpoint module. All external callers
// import from here; internal modules import from their sibling files directly.
//
// Phase H1 — save / load / list / delete (draft only):
//   saveCheckpoint(scope, workspace, name, sessionState, options)
//   loadCheckpoint(scope, workspace, name)
//   listCheckpoints(scope, workspace, options)
//   deleteCheckpoint(scope, workspace, name, options)
//
// Phase H2 additions (not yet implemented — stubs documented for reference):
//   forkCheckpoint(scope, workspace, name)
//
// Phase H3 additions (not yet implemented — stubs documented for reference):
//   pinCheckpoint(workspace, name, options)
//   loadPinnedCheckpoint(workspace, name)
//
// All scoped functions use ``createAgentRuntimeClient(scope)`` internally
// (via checkpoint-client.js). ``pinCheckpoint`` and ``loadPinnedCheckpoint``
// use bare ``runtimeFetch`` (no scope header) — the runtime's
// ``AgentScopeMiddleware`` 403s any scoped POST to ``/api/checkpoints/pin``.

import {
  fetchSaveCheckpoint,
  fetchListCheckpoints,
  fetchLoadCheckpoint,
  fetchDeleteCheckpoint,
  fetchPinCheckpoint,
  fetchListPinnedCheckpoints,
  fetchLoadPinnedCheckpoint
} from "./checkpoint-client.js";

import { compactHistoryForCheckpoint } from "./checkpoint-compact.js";

import {
  applyCheckpointRestore,
  buildForkName,
  buildPreRestoreName,
  buildRestoreNotice
} from "./checkpoint-restore.js";

const CHECKPOINT_SCHEMA = "aamp.checkpoint/1";

// ---------------------------------------------------------------------------
// H1 — Save
// ---------------------------------------------------------------------------

/**
 * Save the current session state as a named draft checkpoint.
 *
 * Validates name format, compacts history if over the 2 MB cap (throwing if
 * compaction is not yet available in H1), then sends to the runtime.
 *
 * ``sessionState`` shape:
 * ```
 * {
 *   history: Array<{role, content}>,
 *   skills: string[],
 *   transientItems: { [key]: { path, encoding } },
 *   runRefs: string[],
 *   manifestRefs: string[],
 *   metadata: {
 *     description?: string,
 *     source?: "operator" | "agent" | "template",
 *     forkOf?: string | null,
 *     forkIndex?: number | null,
 *     preRestoreOf?: string | null
 *   }
 * }
 * ```
 *
 * @param {string} scope  Agent scope — "sandbox" for agent calls, "sandbox" or
 *                        absent for human calls (pass "sandbox" for consistency)
 * @param {string} workspace
 * @param {string} name
 * @param {object} sessionState
 * @param {{ settings?: object }} [options]
 * @returns {Promise<{saved: boolean, path: string, bytes: number}>}
 */
export async function saveCheckpoint(scope, workspace, name, sessionState, options = {}) {
  const {
    history = [],
    skills = [],
    transientItems = {},
    runRefs = [],
    manifestRefs = [],
    metadata = {}
  } = sessionState;

  // Compact if needed. In H1 this throws for oversized history.
  const compactedHistory = await compactHistoryForCheckpoint(history, options.settings);

  const checkpoint = {
    schema: CHECKPOINT_SCHEMA,
    name,
    workspace,
    saved_at: new Date().toISOString(),
    history: compactedHistory,
    skills,
    transient_items: transientItems,
    run_refs: runRefs,
    manifest_refs: manifestRefs,
    metadata: {
      description: metadata.description ?? "",
      source: metadata.source ?? "operator",
      fork_of: metadata.forkOf ?? null,
      fork_index: metadata.forkIndex ?? null,
      pre_restore_of: metadata.preRestoreOf ?? null
    }
  };

  return fetchSaveCheckpoint(scope, workspace, name, checkpoint);
}

// ---------------------------------------------------------------------------
// H1 — Load
// ---------------------------------------------------------------------------

/**
 * Load a draft checkpoint by name. Returns the full checkpoint object.
 *
 * @param {string} scope
 * @param {string} workspace
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function loadCheckpoint(scope, workspace, name) {
  return fetchLoadCheckpoint(scope, workspace, name);
}

// ---------------------------------------------------------------------------
// H1 — List
// ---------------------------------------------------------------------------

/**
 * List checkpoints in a workspace.
 *
 * @param {string} scope
 * @param {string} workspace
 * @param {{ pinned?: boolean }} [options]
 *   Pass ``{ pinned: true }`` to list pinned checkpoints instead of drafts.
 * @returns {Promise<Array<object>>}
 */
export async function listCheckpoints(scope, workspace, options = {}) {
  if (options.pinned) {
    return fetchListPinnedCheckpoints(workspace);
  }
  return fetchListCheckpoints(scope, workspace);
}

// ---------------------------------------------------------------------------
// H1 — Delete
// ---------------------------------------------------------------------------

/**
 * Delete a draft checkpoint.
 *
 * @param {string} scope
 * @param {string} workspace
 * @param {string} name
 * @param {{ force?: boolean }} [options]
 *   Pass ``{ force: true }`` to delete even when a pinned sibling exists.
 * @returns {Promise<{deleted: boolean, name: string, workspace: string, pinned_sibling_exists: boolean}>}
 */
export async function deleteCheckpoint(scope, workspace, name, options = {}) {
  return fetchDeleteCheckpoint(scope, workspace, name, options);
}

// ---------------------------------------------------------------------------
// H2 — Fork (implemented; UI chrome is H2 but the API function is ready)
// ---------------------------------------------------------------------------

/**
 * Fork a draft checkpoint, creating a numbered branch copy.
 *
 * The fork name is ``<name>_fork_<n>`` where ``n`` is one more than the
 * highest existing fork index. The session should switch to the fork name
 * after the call so the original is untouched.
 *
 * @param {string} scope
 * @param {string} workspace
 * @param {string} name  The checkpoint to fork
 * @returns {Promise<string>} The new fork name
 */
export async function forkCheckpoint(scope, workspace, name) {
  const [original, all] = await Promise.all([
    fetchLoadCheckpoint(scope, workspace, name),
    fetchListCheckpoints(scope, workspace)
  ]);

  const forkName = buildForkName(name, all);

  const fork = {
    ...original,
    name: forkName,
    saved_at: new Date().toISOString(),
    metadata: {
      ...(original.metadata || {}),
      source: original.metadata?.source ?? "operator",
      fork_of: name,
      fork_index: parseInt(forkName.split("_fork_").pop(), 10)
    }
  };
  // Forks are always draft — strip any inherited signature.
  delete fork.signature;

  await fetchSaveCheckpoint(scope, workspace, forkName, fork);
  return forkName;
}

// ---------------------------------------------------------------------------
// H3 — Pin / load pinned (API ready; UI chrome is H3)
// ---------------------------------------------------------------------------

/**
 * Pin a draft checkpoint (human-only). Returns the pin response including
 * the embedded signature.
 *
 * ``AgentScopeMiddleware`` blocks any agent-scoped call to the pin endpoint
 * with HTTP 403. This function does not inject a scope header so the runtime
 * can enforce the human-only boundary.
 *
 * @param {string} workspace
 * @param {string} name
 * @param {{ pinnedBy?: string, targetName?: string }} [options]
 * @returns {Promise<{workspace: string, source_relative_path: string, pinned_relative_path: string, bytes_written: number, signature: object}>}
 */
export async function pinCheckpoint(workspace, name, options = {}) {
  return fetchPinCheckpoint(
    workspace,
    name,
    options.pinnedBy || "anonymous_human",
    options.targetName
  );
}

/**
 * Load a pinned checkpoint and verify its embedded HMAC signature.
 *
 * Returns ``{ checkpoint, signature, valid, … }``. ``valid: false`` is NOT
 * an error; the caller decides how to surface the tamper signal.
 *
 * @param {string} workspace
 * @param {string} name
 * @returns {Promise<{workspace: string, name: string, relative_path: string, bytes: number, checkpoint: object, signature: object|null, valid: boolean}>}
 */
export async function loadPinnedCheckpoint(workspace, name) {
  return fetchLoadPinnedCheckpoint(workspace, name);
}

// ---------------------------------------------------------------------------
// Re-export restore helpers (used by UI chrome in H2)
// ---------------------------------------------------------------------------

export { applyCheckpointRestore, buildForkName, buildPreRestoreName, buildRestoreNotice };

export { compactHistoryForCheckpoint } from "./checkpoint-compact.js";
