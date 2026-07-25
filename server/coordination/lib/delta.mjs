// Delta engine (L4 / EP-L) — per-content-hash cursors. Every stage processes only what
// changed since its last run, keyed on (stage, input_content_hash, code_commit, config_hash).
// Unchanged content at the same code+config is never reprocessed; re-running is idempotent and
// resumable; out-of-order cross-machine arrival is tolerated because HLC valid-time resolves the
// true sequence. Cursors are `cursor_advanced` KEL events (no separate store — reuse L0). R8–R11.
// Design: SOLUTION §4.3 + §5.3 (steer 3).
import { ulid, appendKelEvent, readKelEvents } from "./kel.mjs";

// The cursor key is the finest grain: a change to any component reprocesses the input.
export function cursorKey({ stage, inputContentHash, codeCommit, configHash }) {
  return `${stage}|${inputContentHash}|${codeCommit}|${configHash}`;
}

// Fold the cursor_advanced events into a key → {status, outputs} map (latest wins).
export function foldCursors(events) {
  const m = new Map();
  for (const e of events) {
    if (e.type !== "cursor_advanced") continue;
    const p = e.payload || {};
    const key = cursorKey({
      stage: p.stage,
      inputContentHash: p.input_content_hash,
      codeCommit: p.code_commit,
      configHash: p.config_hash
    });
    m.set(key, { status: p.status, outputs: p.outputs || [], run_id: p.run_id ?? null });
  }
  return m;
}

// Append a `done` cursor for one processed input.
export function recordCursor(logFile, { stage, inputContentHash, codeCommit, configHash, machine = "t480", runId = null, outputs = [] }) {
  const now = new Date().toISOString();
  return appendKelEvent(logFile, {
    id: ulid(),
    schema_version: "1.0.0",
    type: "cursor_advanced",
    valid_time: now,
    txn_time: now,
    time_confidence: "known",
    hlc: `${now}-0000-${machine}`,
    machine,
    authorship: "house",
    sid: `cursor:${stage}`,
    subject: { kind: "cursor", id: cursorKey({ stage, inputContentHash, codeCommit, configHash }) },
    payload: { stage, input_content_hash: inputContentHash, code_commit: codeCommit, config_hash: configHash, status: "done", outputs, run_id: runId }
  });
}

// Process a batch: run only inputs without a `done` cursor; record a cursor for each.
// Idempotent (a second call skips everything) and resumable (an interrupted run redoes only the
// not-yet-done inputs). `run(input)` returns the stage outputs; omit it for a dry inventory.
export function processDelta(logFile, inputs, { stage, codeCommit, configHash, run, machine = "t480" }) {
  const { events } = readKelEvents(logFile);
  const done = foldCursors(events);
  const processed = [];
  const skipped = [];
  for (const input of inputs) {
    const key = cursorKey({ stage, inputContentHash: input.content_hash, codeCommit, configHash });
    if (done.get(key)?.status === "done") {
      skipped.push(input.content_hash);
      continue;
    }
    const outputs = run ? run(input) : [];
    recordCursor(logFile, { stage, inputContentHash: input.content_hash, codeCommit, configHash, machine, outputs });
    done.set(key, { status: "done", outputs }); // guard against a repeated hash within one batch
    processed.push(input.content_hash);
  }
  return { processed, skipped };
}

// Ordering-tolerant: apply deltas in valid-time (then HLC) order regardless of arrival order (R11).
export function applyInValidTimeOrder(items) {
  return [...items].sort(
    (a, b) =>
      Date.parse(a.valid_time) - Date.parse(b.valid_time) ||
      (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0)
  );
}
