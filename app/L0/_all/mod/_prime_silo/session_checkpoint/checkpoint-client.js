// ADR-001 Phase H — checkpoint fetch helpers.
//
// One fetch function per runtime endpoint. All scoped helpers receive a
// ``scope`` string and use ``createAgentRuntimeClient`` so every call
// carries ``X-Benny-Agent-Scope`` through the shell proxy — same transport
// chokepoint as ``saveView`` / ``loadView``.
//
// Pin and load-pinned use bare ``runtimeFetch`` (no scope header) because
// those routes live outside ``/api/agent_sandbox/`` and
// ``AgentScopeMiddleware`` issues 403 to any agent-scoped POST there.
//
// Path conventions (relative to the runtime proxy root):
//   draft:   /agent_sandbox/checkpoints/save          POST
//            /agent_sandbox/checkpoints/list/<ws>      GET
//            /agent_sandbox/checkpoints/load/<ws>/<n>  GET
//            /agent_sandbox/checkpoints/delete/<ws>/<n> DELETE
//   pinned:  /checkpoints/pin                         POST
//            /checkpoints/list/<ws>                   GET
//            /checkpoints/load/<ws>/<n>               GET

import {
  createAgentRuntimeClient,
  runtimeFetch,
  readRuntimeJson,
  withAgentScope,
} from "../runtime_client/runtime-client.js";

// ---------------------------------------------------------------------------
// Draft operations (sandbox-scoped)
// ---------------------------------------------------------------------------

/**
 * POST /api/agent_sandbox/checkpoints/save
 * Returns { saved: true, path, bytes }
 *
 * @param {string} scope
 * @param {string} workspace
 * @param {string} name
 * @param {object} checkpoint  Full aamp.checkpoint/1 object
 * @returns {Promise<{saved: boolean, path: string, bytes: number}>}
 */
export async function fetchSaveCheckpoint(scope, workspace, name, checkpoint) {
  const response = await withAgentScope(scope, () =>
    runtimeFetch("/agent_sandbox/checkpoints/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, name, checkpoint }),
    })
  );
  return readRuntimeJson(response);
}

/**
 * GET /api/agent_sandbox/checkpoints/list/<ws>
 * Returns CheckpointSummary[] (metadata only, no history).
 *
 * @param {string} scope
 * @param {string} workspace
 * @returns {Promise<Array<{name: string, saved_at: string, status: string, skill_count: number, message_count: number, run_refs: string[], manifest_refs: string[], source: string, fork_of: string|null, description: string}>>}
 */
export async function fetchListCheckpoints(scope, workspace) {
  const response = await withAgentScope(scope, () =>
    runtimeFetch(`/agent_sandbox/checkpoints/list/${encodeURIComponent(workspace)}`)
  );
  return readRuntimeJson(response);
}

/**
 * GET /api/agent_sandbox/checkpoints/load/<ws>/<name>
 * Returns the full checkpoint object (history included).
 *
 * @param {string} scope
 * @param {string} workspace
 * @param {string} name
 * @returns {Promise<object>} Full aamp.checkpoint/1 object
 */
export async function fetchLoadCheckpoint(scope, workspace, name) {
  const response = await withAgentScope(scope, () =>
    runtimeFetch(
      `/agent_sandbox/checkpoints/load/${encodeURIComponent(workspace)}/${encodeURIComponent(name)}`
    )
  );
  return readRuntimeJson(response);
}

/**
 * DELETE /api/agent_sandbox/checkpoints/delete/<ws>/<name>
 * Returns { deleted: true, name, workspace, pinned_sibling_exists }
 * Throws RuntimeError(409) when a pinned sibling exists and force=false.
 *
 * @param {string} scope
 * @param {string} workspace
 * @param {string} name
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{deleted: boolean, name: string, workspace: string, pinned_sibling_exists: boolean}>}
 */
export async function fetchDeleteCheckpoint(scope, workspace, name, options = {}) {
  const qs = options.force ? "?force=true" : "";
  const response = await withAgentScope(scope, () =>
    runtimeFetch(
      `/agent_sandbox/checkpoints/delete/${encodeURIComponent(workspace)}/${encodeURIComponent(name)}${qs}`,
      { method: "DELETE" }
    )
  );
  return readRuntimeJson(response);
}

// ---------------------------------------------------------------------------
// Pinned operations (human-scoped — no agent scope header)
// ---------------------------------------------------------------------------

/**
 * POST /api/checkpoints/pin
 * Promotes a draft to a signed, canonical pinned checkpoint.
 * Human-only — AgentScopeMiddleware issues 403 to any scoped caller.
 *
 * @param {string} workspace
 * @param {string} sourceName
 * @param {string} pinnedBy
 * @param {string} [targetName]
 * @returns {Promise<{workspace: string, source_relative_path: string, pinned_relative_path: string, bytes_written: number, signature: object}>}
 */
export async function fetchPinCheckpoint(workspace, sourceName, pinnedBy, targetName) {
  const payload = {
    workspace,
    source_name: sourceName,
    pinned_by: pinnedBy || "anonymous_human",
  };
  if (targetName) {
    payload.target_name = targetName;
  }
  const response = await runtimeFetch("/checkpoints/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readRuntimeJson(response);
}

/**
 * GET /api/checkpoints/list/<ws>
 * Lists pinned checkpoints (with valid boolean per entry).
 *
 * @param {string} workspace
 * @returns {Promise<Array<{name: string, saved_at: string, status: "pinned", valid: boolean, ...}>>}
 */
export async function fetchListPinnedCheckpoints(workspace) {
  const response = await runtimeFetch(
    `/checkpoints/list/${encodeURIComponent(workspace)}`
  );
  return readRuntimeJson(response);
}

/**
 * GET /api/checkpoints/load/<ws>/<name>
 * Reads a pinned checkpoint and verifies its embedded HMAC in one round-trip.
 * Returns { checkpoint, signature, valid, … }.
 * Reads are unrestricted — agents may load pinned checkpoints.
 *
 * @param {string} workspace
 * @param {string} name
 * @returns {Promise<{workspace: string, name: string, relative_path: string, bytes: number, checkpoint: object, signature: object|null, valid: boolean}>}
 */
export async function fetchLoadPinnedCheckpoint(workspace, name) {
  const response = await runtimeFetch(
    `/checkpoints/load/${encodeURIComponent(workspace)}/${encodeURIComponent(name)}`
  );
  return readRuntimeJson(response);
}
