// ADR-001 Phase H — checkpoint history compaction.
//
// Pre-save size check for session checkpoints. The server enforces a hard
// 2 MB cap (HTTP 413). This module provides the browser-side check so the
// caller can react before the round-trip.
//
// Phase H1: size-check only. If the history is within the 2 MB cap it is
// returned as-is. If it exceeds the cap and no compaction function is
// provided, the call throws with a clear user-facing message so the operator
// knows to compact their conversation history first.
//
// Phase H2 will add LLM-driven compaction using the existing
// ``fetchOnscreenAgentHistoryCompactPrompt`` mechanism. The interface is
// designed so H2 can drop in the full implementation without changing callers:
//
//   import { compactHistoryForCheckpoint } from "./checkpoint-compact.js";
//   const compactedHistory = await compactHistoryForCheckpoint(history, settings);
//
// ``settings`` is passed through to the LLM compaction function in H2.
// In H1 it is accepted but not used.

const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Check the byte size of ``history`` and return it if within the cap.
 *
 * If the serialised size exceeds 2 MB, throw an error with a clear message
 * directing the operator to compact their conversation first. The server
 * will also reject oversized payloads with HTTP 413; this is the
 * browser-side early guard.
 *
 * Phase H2 will replace the throw with an LLM-driven compaction step that
 * summarises the history into a single pair of summary messages before saving.
 *
 * @param {Array<{role: string, content: string}>} history
 * @param {object} [settings]  LLM settings (used in H2; ignored in H1)
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function compactHistoryForCheckpoint(history, settings) {
  if (!Array.isArray(history)) {
    return [];
  }

  const serialised = JSON.stringify(history);
  const byteLength = new TextEncoder().encode(serialised).length;

  if (byteLength <= MAX_CHECKPOINT_BYTES) {
    return history;
  }

  // Phase H1: no LLM compaction yet — surface a clear error.
  // Phase H2 will call fetchOnscreenAgentHistoryCompactPrompt here.
  throw new Error(
    `Session history is too large to checkpoint (${(byteLength / 1024 / 1024).toFixed(1)} MB). ` +
      "Compact your conversation history first (use the history compact action in the agent panel), " +
      "then retry the checkpoint save. " +
      `Maximum checkpoint size is ${(MAX_CHECKPOINT_BYTES / 1024 / 1024).toFixed(0)} MB.`
  );
}

/**
 * Return the estimated byte length of a history array without compaction.
 * Useful for UI to warn before attempting a save.
 *
 * @param {Array<{role: string, content: string}>} history
 * @returns {number} byte length
 */
export function estimateHistoryBytes(history) {
  if (!Array.isArray(history)) return 0;
  return new TextEncoder().encode(JSON.stringify(history)).length;
}

/**
 * Return true if history is within the 2 MB save cap.
 *
 * @param {Array<{role: string, content: string}>} history
 * @returns {boolean}
 */
export function isHistoryWithinCheckpointLimit(history) {
  return estimateHistoryBytes(history) <= MAX_CHECKPOINT_BYTES;
}

export const __testing = {
  MAX_CHECKPOINT_BYTES
};
