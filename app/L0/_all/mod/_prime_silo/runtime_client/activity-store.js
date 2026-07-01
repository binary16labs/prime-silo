// App-wide run-activity store — ONE subscription to the runtime's global
// event feed, shared by every screen.
//
// Before this store each screen owned its own timer (bridge pollDeepProduce /
// pollStudioCell, mission_control liveSync, lifelog poll), so a run started on
// one screen was invisible everywhere else. Now:
//
//   • Primary transport: SSE — GET /api/runtime/workflows/events (the
//     EventBus.subscribe_all fan-in; heartbeats every 15s). Streamed through
//     the shell proxy via runtimeFetch, so credential injection keeps its one
//     chokepoint.
//   • Fallback: polling GET /api/runtime/manifests/runs every POLL_MS while
//     the stream is down (with reconnect + backoff).
//
// Status vocabulary is the runtime's RunStatus enum verbatim:
//   pending | planning | running | completed | partial_success | failed | cancelled
// (benny/core/manifest.py — do not invent synonyms in the UI.)
//
// Public API
//   subscribeActivity(listener) → unsubscribe()   listener(snapshot) on change
//   getActivitySnapshot()                          current snapshot
//   snapshot: {
//     transport: "sse" | "poll" | "connecting",
//     runs:     [{ runId, workspace, status, lastEventType, stage,
//                  startedAt, updatedAt, error }],   newest first, max 50
//     running:  count of pending/planning/running runs,
//     failures: count of failed runs seen this session
//   }

import { runtimeFetch, readRuntimeJson } from "./runtime-client.js";

const POLL_MS = 5000;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const MAX_RUNS = 50;

const ACTIVE_STATUSES = new Set(["pending", "planning", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "partial_success", "failed", "cancelled"]);

// Event-type → status mapping for EventBus lifecycle events. Anything not
// listed just refreshes the run's lastEventType/stage (progress telemetry).
const EVENT_STATUS = {
  workflow_started: "running",
  workflow_running: "running",
  workflow_completed: "completed",
  workflow_failed: "failed",
  workflow_cancelled: "cancelled"
};

const state = {
  runs: new Map(), // runId -> run entry
  transport: "connecting",
  failures: 0,
  listeners: new Set(),
  started: false,
  stopped: false,
  pollTimer: null,
  reconnectMs: RECONNECT_MIN_MS,
  streamAbort: null
};

function snapshot() {
  const runs = [...state.runs.values()].sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || "")
  );
  return {
    transport: state.transport,
    runs,
    running: runs.filter((r) => ACTIVE_STATUSES.has(r.status)).length,
    failures: state.failures
  };
}

function notify() {
  const snap = snapshot();
  for (const listener of state.listeners) {
    try {
      listener(snap);
    } catch {
      // One bad listener never breaks the fan-out.
    }
  }
}

function upsertRun(runId, patch) {
  if (!runId) return;
  const prev = state.runs.get(runId) || {
    runId,
    workspace: "",
    status: "pending",
    lastEventType: "",
    stage: "",
    startedAt: "",
    updatedAt: "",
    error: ""
  };
  const wasTerminalFailed = prev.status === "failed";
  const next = { ...prev, ...patch, runId };
  state.runs.set(runId, next);
  if (next.status === "failed" && !wasTerminalFailed) {
    state.failures += 1;
  }
  // Bound the map: drop the oldest terminal runs beyond MAX_RUNS.
  if (state.runs.size > MAX_RUNS) {
    const byAge = [...state.runs.values()]
      .filter((r) => TERMINAL_STATUSES.has(r.status))
      .sort((a, b) => (a.updatedAt || "").localeCompare(b.updatedAt || ""));
    for (const victim of byAge.slice(0, state.runs.size - MAX_RUNS)) {
      state.runs.delete(victim.runId);
    }
  }
}

function applyEvent(event) {
  if (!event || typeof event !== "object" || event.type === "heartbeat") return false;
  const runId = event.run_id || event.runId || "";
  if (!runId) return false;
  const patch = {
    lastEventType: String(event.type || ""),
    updatedAt: String(event.timestamp || new Date().toISOString())
  };
  const mapped = EVENT_STATUS[event.type];
  if (mapped) patch.status = mapped;
  if (event.workspace) patch.workspace = String(event.workspace);
  if (event.stage || event.node || event.step) {
    patch.stage = String(event.stage || event.node || event.step);
  }
  if (event.error) patch.error = String(event.error);
  if (event.type === "workflow_started") patch.startedAt = patch.updatedAt;
  upsertRun(runId, patch);
  return true;
}

// ── SSE transport ────────────────────────────────────────────────────────────

async function runStream() {
  const controller = new AbortController();
  state.streamAbort = controller;
  const response = await runtimeFetch("/workflows/events", {
    signal: controller.signal,
    headers: { Accept: "text/event-stream" }
  });
  if (!response.ok || !response.body) {
    throw new Error(`events stream unavailable (${response.status})`);
  }

  state.transport = "sse";
  state.reconnectMs = RECONNECT_MIN_MS;
  stopPolling();
  notify();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    let changed = false;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          changed = applyEvent(JSON.parse(line.slice(5).trim())) || changed;
        } catch {
          // Malformed frame — skip; the stream self-heals on the next event.
        }
      }
    }
    if (changed) notify();
  }
  throw new Error("events stream ended");
}

async function streamLoop() {
  while (!state.stopped) {
    try {
      await runStream();
    } catch {
      if (state.stopped) return;
      state.transport = "poll";
      startPolling();
      notify();
      await new Promise((resolve) => setTimeout(resolve, state.reconnectMs));
      state.reconnectMs = Math.min(state.reconnectMs * 2, RECONNECT_MAX_MS);
    }
  }
}

// ── polling fallback ─────────────────────────────────────────────────────────

async function pollOnce() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  try {
    const records = await readRuntimeJson(await runtimeFetch("/manifests/runs?limit=25"));
    if (!Array.isArray(records)) return;
    let changed = false;
    for (const record of records) {
      const runId = record.run_id || "";
      if (!runId) continue;
      const prev = state.runs.get(runId);
      const status = String(record.status || "pending");
      if (prev && prev.status === status) continue;
      upsertRun(runId, {
        workspace: String(record.workspace || ""),
        status,
        startedAt: String(record.started_at || ""),
        updatedAt: String(record.completed_at || record.started_at || ""),
        error: String(record.error || "")
      });
      changed = true;
    }
    if (changed) notify();
  } catch {
    // Runtime down: keep the last snapshot; the stream loop keeps retrying.
  }
}

function startPolling() {
  if (state.pollTimer) return;
  void pollOnce();
  state.pollTimer = setInterval(() => void pollOnce(), POLL_MS);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// ── public API ───────────────────────────────────────────────────────────────

export function subscribeActivity(listener) {
  if (typeof listener === "function") {
    state.listeners.add(listener);
    // Immediate snapshot so subscribers render without waiting for an event.
    try {
      listener(snapshot());
    } catch {
      // ignore listener errors
    }
  }
  if (!state.started) {
    state.started = true;
    // Seed recent history (the stream starts at "now"), then hold the stream.
    void pollOnce();
    void streamLoop();
  }
  return () => {
    state.listeners.delete(listener);
  };
}

export function getActivitySnapshot() {
  return snapshot();
}

// Test seam: reset the singleton between test cases.
export function _resetActivityStoreForTests() {
  state.stopped = true;
  if (state.streamAbort) state.streamAbort.abort();
  stopPolling();
  state.runs.clear();
  state.listeners.clear();
  state.transport = "connecting";
  state.failures = 0;
  state.started = false;
  state.stopped = false;
  state.reconnectMs = RECONNECT_MIN_MS;
}
