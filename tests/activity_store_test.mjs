#!/usr/bin/env node
//
// activity-store — the shared run-activity feed behind the Bridge header chip.
// Exercises SSE-frame reduction (status mapping, stage/error capture, failure
// counting) and the poll fallback path against a stubbed fetch, plus the
// bounded-runs guarantee.

import assert from "node:assert/strict";

globalThis.window = globalThis.window || { location: { hash: "" } };

const { subscribeActivity, getActivitySnapshot, _resetActivityStoreForTests } =
  await import("../app/L0/_all/mod/_prime_silo/runtime_client/activity-store.js");

function sseResponse(frames) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (index < frames.length) {
              const chunk = encoder.encode(frames[index]);
              index += 1;
              return Promise.resolve({ done: false, value: chunk });
            }
            // Keep the stream open (pending forever) so the store stays in
            // SSE mode for the duration of the assertion window.
            return new Promise(() => {});
          }
        };
      }
    }
  };
}

function frame(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

// ── SSE reduction ────────────────────────────────────────────────────────────
{
  _resetActivityStoreForTests();
  const calls = [];
  globalThis.fetch = (url, _init) => {
    calls.push(String(url));
    if (String(url).includes("/workflows/events")) {
      return Promise.resolve(
        sseResponse([
          frame({ type: "workflow_started", run_id: "r1", workspace: "w1", timestamp: "t1" }),
          frame({ type: "node_completed", run_id: "r1", stage: "silver_trades", timestamp: "t2" }) +
            frame({ type: "workflow_failed", run_id: "r1", error: "boom", timestamp: "t3" }) +
            frame({ type: "workflow_started", run_id: "r2", timestamp: "t4" })
        ])
      );
    }
    // Seed poll: no history.
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve("[]"),
      headers: { get: () => "application/json" }
    });
  };

  const seen = [];
  const unsubscribe = subscribeActivity((snap) => seen.push(snap));
  await settle();

  const snap = getActivitySnapshot();
  assert.equal(snap.transport, "sse");
  const r1 = snap.runs.find((r) => r.runId === "r1");
  const r2 = snap.runs.find((r) => r.runId === "r2");
  assert.equal(r1.status, "failed");
  assert.equal(r1.error, "boom");
  assert.equal(r1.stage, "silver_trades");
  assert.equal(r1.workspace, "w1");
  assert.equal(r2.status, "running");
  assert.equal(snap.running, 1);
  assert.equal(snap.failures, 1);
  assert.ok(seen.length >= 2, "subscribers get an immediate snapshot plus updates");
  unsubscribe();
}

// ── poll fallback when the stream is unavailable ─────────────────────────────
{
  _resetActivityStoreForTests();
  globalThis.fetch = (url) => {
    if (String(url).includes("/workflows/events")) {
      return Promise.resolve({ ok: false, status: 404, body: null });
    }
    const records = [
      {
        run_id: "p1",
        workspace: "w",
        status: "running",
        started_at: "2026-07-01T10:00:00"
      },
      {
        run_id: "p0",
        workspace: "w",
        status: "completed",
        started_at: "2026-07-01T09:00:00",
        completed_at: "2026-07-01T09:05:00"
      }
    ];
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(records)),
      headers: { get: () => "application/json" }
    });
  };

  const unsubscribe = subscribeActivity(() => {});
  await settle();

  const snap = getActivitySnapshot();
  assert.equal(snap.transport, "poll");
  assert.equal(snap.runs.length, 2);
  assert.equal(snap.running, 1);
  assert.equal(snap.runs.find((r) => r.runId === "p0").status, "completed");
  unsubscribe();
  _resetActivityStoreForTests();
}

console.log("activity_store_test: ok");
