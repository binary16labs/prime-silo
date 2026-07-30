#!/usr/bin/env node
//
// mascot-state (C5) — Benny idle/listening/processing micro-states.
//
// Scenario: "processing means processing" — drives the REAL activity-store
// (runtime_client/activity-store.js) with a mocked SSE transport (the same
// fetch+ReadableStream stub used by tests/activity_store_test.mjs, which is
// what actually carries the EventBus.subscribe_all stream in the browser)
// and asserts the mascot's data-mascot-state attribute follows it:
// idle -> processing (on workflow_started) -> idle (on workflow_completed).
// No timer is used anywhere in this path — the state changes must trace
// back to a fetched SSE frame or a real focus event.
//
// Scenario: "reduced motion is respected" is a CSS-media-query concern with
// no CSSOM in plain Node; it is covered by scripts/gates/c5.mjs's static
// analysis of mod/_core/visual/mascot-motion.css (keyframes + guard
// present) rather than duplicated here. See that gate for the check.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

globalThis.window = globalThis.window || { location: { hash: "" } };

const { subscribeActivity, _resetActivityStoreForTests } =
  await import("../app/L0/_all/mod/_prime_silo/runtime_client/activity-store.js");
const { initMascotState, deriveState, applyMascotState } =
  await import("../app/L0/_all/mod/_prime_silo/mascot_state/mascot-state.js");

// ── deriveState / applyMascotState: pure-logic unit checks ─────────────────
{
  assert.equal(deriveState({ running: false, focused: false }), "idle");
  assert.equal(deriveState({ running: false, focused: true }), "listening");
  assert.equal(deriveState({ running: true, focused: false }), "processing");
  // Real activity outranks focus — Benny never lies about what's happening.
  assert.equal(deriveState({ running: true, focused: true }), "processing");

  const fakeEl = { dataset: {} };
  applyMascotState(fakeEl, "processing");
  assert.equal(fakeEl.dataset.mascotState, "processing");
  applyMascotState(null, "idle"); // must not throw
  console.log("[mascot_state_test] PASS — deriveState/applyMascotState pure logic");
}

// ── Scenario: processing means processing (real activity-store, mocked SSE) ─
{
  _resetActivityStoreForTests();

  // A single continuous connection carrying two real frames: workflow_started
  // then, after a delay, workflow_completed — same run. The second frame is
  // deliberately delayed so the test can observe the intermediate
  // "processing" state before the stream quiets back to "idle".
  function delayedSseResponse(frames) {
    const encoder = new TextEncoder();
    let index = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read() {
              if (index >= frames.length) return new Promise(() => {}); // hold open
              const { text, delayMs } = frames[index];
              index += 1;
              const chunk = encoder.encode(text);
              if (!delayMs) return Promise.resolve({ done: false, value: chunk });
              return new Promise((resolve) =>
                setTimeout(() => resolve({ done: false, value: chunk }), delayMs)
              );
            }
          };
        }
      }
    };
  }
  const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;

  globalThis.fetch = (url) => {
    if (String(url).includes("/workflows/events")) {
      return Promise.resolve(
        delayedSseResponse([
          {
            text: frame({
              type: "workflow_started",
              run_id: "r1",
              workspace: "w1",
              timestamp: "t1"
            })
          },
          {
            text: frame({
              type: "workflow_completed",
              run_id: "r1",
              workspace: "w1",
              timestamp: "t2"
            }),
            delayMs: 60
          }
        ])
      );
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  };

  // Minimal fake `doc`: a mascot element plus an EventEmitter standing in
  // for focusin/focusout wiring (unused in this scenario — the point here
  // is the activity path, not focus).
  const mascotEl = { dataset: {} };
  const emitter = new EventEmitter();
  const fakeDoc = {
    querySelector: (sel) => (sel === ".onscreen-agent-avatar-button" ? mascotEl : null),
    addEventListener: (type, fn) => emitter.on(type, fn),
    removeEventListener: (type, fn) => emitter.off(type, fn),
    body: null // no MutationObserver path exercised here — el exists up front
  };

  initMascotState({ doc: fakeDoc, subscribeActivity });

  assert.equal(mascotEl.dataset.mascotState, "idle", "starts idle before any activity");

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    mascotEl.dataset.mascotState,
    "processing",
    "a real workflow_started SSE frame flips the mascot to processing"
  );

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(
    mascotEl.dataset.mascotState,
    "idle",
    "returns to idle once the stream quiets (workflow_completed on the same run)"
  );

  console.log("[mascot_state_test] PASS — idle -> processing -> idle via real activity-store");
}

console.log("[mascot_state_test] ALL SCENARIOS PASS");
