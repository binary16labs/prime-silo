// ADR-001 Phase E expansion — pure mapping helpers for the runs explorer.
//
// Three jobs:
//   1. `summariseRun(record)` — small block of strings shown in the page
//      header so an operator can tell what they're looking at before the
//      DAG paints.
//   2. `buildRunOverlay(record)` — pull `node_states` (and only the bits
//      the dag.canvas understands) into the shape `mapManifestToDagData`
//      accepts as `options.runOverlay`.
//   3. `sortRunsForDisplay(runs)` — newest first; in-progress runs float
//      to the top so the operator's eye lands on the live thing.
//
// All three are pure and dependency-free so the .mjs test runner can
// exercise them without DOM, fetch, or a runtime.

const STATUS_DISPLAY = {
  pending:   "Pending",
  running:   "Running",
  completed: "Completed",
  failed:    "Failed",
  cancelled: "Cancelled"
};

const ACTIVE_STATUSES = new Set(["pending", "running"]);

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

export function escapeHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Return a small display object describing the run. Mirrors
 * `summariseManifest` in the manifest_explorer — the page header consumes
 * both to render side-by-side.
 *
 * @param {object} record — a RunRecord (Pydantic model from
 *   runtime/benny/core/manifest.py) or null
 * @returns {{
 *   runId: string, manifestId: string, workspace: string,
 *   status: string, statusDisplay: string,
 *   startedAt: string, completedAt: string,
 *   durationMs: number | null,
 *   nodeStateCount: number, errorCount: number, hasFinalDocument: boolean
 * }}
 */
export function summariseRun(record) {
  if (!record || typeof record !== "object") {
    return {
      runId: "", manifestId: "", workspace: "",
      status: "", statusDisplay: "",
      startedAt: "", completedAt: "",
      durationMs: null,
      nodeStateCount: 0, errorCount: 0, hasFinalDocument: false
    };
  }
  const status = typeof record.status === "string" ? record.status : "";
  const nodeStates = record.node_states && typeof record.node_states === "object"
    ? record.node_states
    : {};
  const errors = Array.isArray(record.errors) ? record.errors : [];
  return {
    runId:           typeof record.run_id === "string" ? record.run_id : "",
    manifestId:      typeof record.manifest_id === "string" ? record.manifest_id : "",
    workspace:       typeof record.workspace === "string" ? record.workspace : "",
    status,
    statusDisplay:   STATUS_DISPLAY[status] || status || "Unknown",
    startedAt:       typeof record.started_at === "string" ? record.started_at : "",
    completedAt:     typeof record.completed_at === "string" ? record.completed_at : "",
    durationMs:      typeof record.duration_ms === "number" ? record.duration_ms : null,
    nodeStateCount:  Object.keys(nodeStates).length,
    errorCount:      errors.length,
    hasFinalDocument: typeof record.final_document === "string" && record.final_document.length > 0
  };
}

/**
 * Extract the dag.canvas-consumable run overlay from a RunRecord.
 *
 * The overlay shape `mapManifestToDagData` expects is
 *   { node_states: { task_id: status } }
 *
 * The RunRecord carries that map already, but a malformed or partially-
 * written record (running task without final state, e.g.) must not throw.
 * Anything non-string in the value position is dropped — `dag.canvas`
 * only branches on known status strings, and an unknown value would just
 * paint the task as `pending`. Better to drop and let the task render in
 * its baseline state.
 *
 * Returns `null` when the record has no usable overlay so callers can
 * skip the `options.runOverlay` argument entirely.
 */
export function buildRunOverlay(record) {
  if (!record || typeof record !== "object") return null;
  const raw = record.node_states;
  if (!raw || typeof raw !== "object") return null;
  const cleaned = {};
  let any = false;
  for (const [taskId, status] of Object.entries(raw)) {
    if (typeof taskId !== "string" || !taskId) continue;
    if (typeof status !== "string" || !status) continue;
    cleaned[taskId] = status;
    any = true;
  }
  return any ? { node_states: cleaned } : null;
}

/**
 * Pull the manifest body out of a RunRecord when one is embedded.
 *
 * `RunRecord.manifest_snapshot` is an optional cached copy taken at run
 * creation — the planner snapshots the manifest so the run's DAG keeps
 * rendering even if the manifest is later edited. When present we use
 * it; otherwise the caller falls back to a fresh /manifests/<id> fetch.
 *
 * Returns the snapshot dict or `null`. We do NOT throw on a malformed
 * snapshot — a snapshot we can't read is just absent.
 */
export function extractManifestSnapshot(record) {
  if (!record || typeof record !== "object") return null;
  const snap = record.manifest_snapshot;
  if (!snap || typeof snap !== "object") return null;
  // Must look at least like a SwarmManifest envelope for the mapping
  // function to be willing to consume it (it wants `plan`).
  if (!snap.plan || typeof snap.plan !== "object") return null;
  return snap;
}

/**
 * Sort runs for display. Rules, in priority order:
 *
 *   1. Active runs (`pending`, `running`) float to the top — operators
 *      land on the thing that's live.
 *   2. Within a status bucket, newest `started_at` first.
 *   3. Records with missing `started_at` sort last in their bucket so
 *      they don't muddy the timeline.
 *
 * Returns a NEW array — does not mutate the input.
 */
export function sortRunsForDisplay(runs) {
  if (!Array.isArray(runs)) return [];
  const copy = runs.slice();
  copy.sort((a, b) => {
    const aActive = ACTIVE_STATUSES.has(a && a.status) ? 0 : 1;
    const bActive = ACTIVE_STATUSES.has(b && b.status) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    const aT = a && typeof a.started_at === "string" ? a.started_at : "";
    const bT = b && typeof b.started_at === "string" ? b.started_at : "";
    if (aT && bT) return aT < bT ? 1 : aT > bT ? -1 : 0;
    if (aT) return -1;
    if (bT) return 1;
    return 0;
  });
  return copy;
}

/**
 * Pretty-print a duration in milliseconds for the header summary.
 * 12000 → "12.0s"; 90000 → "1m 30s"; 3700000 → "1h 1m"; null → "—".
 */
export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 10) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms - m * 60_000) / 1000);
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms - h * 3_600_000) / 60_000);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
