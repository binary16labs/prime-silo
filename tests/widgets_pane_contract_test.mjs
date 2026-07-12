#!/usr/bin/env node
//
// C1 — shared PaneContract helper.
//
// Exercises the debounce/dispose contract against fake DOM +
// ResizeObserver doubles (no real browser).

import assert from "node:assert/strict";

import { createPaneContract } from "../app/L0/_all/mod/_prime_silo/widgets/pane_contract.js";

async function main() {
  testMeasuresImmediatelyByDefault();
  testImmediateFalseSkipsInitialFire();
  await testResizeObserverCallbackIsDebounced();
  await testWindowResizeAlsoTriggersDebouncedFire();
  testDisposeStopsFurtherCallbacks();
  testNoOpsWithoutRectOrObserver();

  console.log("widgets_pane_contract_test: ok");
}

class FakeResizeObserver {
  constructor(cb) {
    this.cb = cb;
    this.observed = [];
    FakeResizeObserver.instances.push(this);
  }
  observe(el) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    this.cb();
  }
}
FakeResizeObserver.instances = [];

function fakeWindow() {
  const listeners = {};
  return {
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    fire(type) {
      for (const fn of listeners[type] || []) fn();
    },
    listenerCount(type) {
      return (listeners[type] || []).length;
    }
  };
}

function fakeHost({ width = 300, height = 200, withWindow = true } = {}) {
  const win = withWindow ? fakeWindow() : null;
  return {
    _rect: { width, height },
    getBoundingClientRect() {
      return this._rect;
    },
    ownerDocument: win ? { defaultView: win } : null,
    __win: win
  };
}

function flushAsync(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testMeasuresImmediatelyByDefault() {
  const host = fakeHost({ width: 640, height: 480 });
  const calls = [];
  const handle = createPaneContract(host, (size) => calls.push(size));
  assert.deepEqual(calls, [{ width: 640, height: 480 }]);
  handle.dispose();
}

function testImmediateFalseSkipsInitialFire() {
  const host = fakeHost();
  const calls = [];
  const handle = createPaneContract(host, (size) => calls.push(size), { immediate: false });
  assert.deepEqual(calls, []);
  handle.dispose();
}

async function testResizeObserverCallbackIsDebounced() {
  const origRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver;
  FakeResizeObserver.instances = [];
  try {
    const host = fakeHost({ withWindow: false, width: 100, height: 100 });
    const calls = [];
    const handle = createPaneContract(host, (size) => calls.push(size), {
      immediate: false,
      debounceMs: 10
    });
    const ro = FakeResizeObserver.instances[0];
    assert.ok(ro, "ResizeObserver should have been constructed and observing the host");
    assert.equal(ro.observed[0], host);

    // Several rapid resize notifications (a drag-resize) should coalesce
    // into exactly ONE debounced callback, using the LATEST size.
    host._rect = { width: 100, height: 100 };
    ro.fire();
    host._rect = { width: 200, height: 150 };
    ro.fire();
    host._rect = { width: 320, height: 240 };
    ro.fire();
    assert.deepEqual(calls, [], "must not fire synchronously");
    await flushAsync(30);
    assert.deepEqual(calls, [{ width: 320, height: 240 }]);
    handle.dispose();
  } finally {
    globalThis.ResizeObserver = origRO;
  }
}

async function testWindowResizeAlsoTriggersDebouncedFire() {
  const host = fakeHost({ withWindow: true, width: 50, height: 40 });
  const calls = [];
  const handle = createPaneContract(host, (size) => calls.push(size), {
    immediate: false,
    debounceMs: 10
  });
  host._rect = { width: 900, height: 600 };
  host.__win.fire("resize");
  await flushAsync(30);
  assert.deepEqual(calls, [{ width: 900, height: 600 }]);
  handle.dispose();
}

function testDisposeStopsFurtherCallbacks() {
  const origRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver;
  FakeResizeObserver.instances = [];
  try {
    const host = fakeHost({ withWindow: true });
    const handle = createPaneContract(host, () => {}, { immediate: false });
    const ro = FakeResizeObserver.instances[0];
    handle.dispose();
    assert.equal(ro.disconnected, true);
    assert.equal(host.__win.listenerCount("resize"), 0);
  } finally {
    globalThis.ResizeObserver = origRO;
  }
}

function testNoOpsWithoutRectOrObserver() {
  // No getBoundingClientRect, no ResizeObserver global, no ownerDocument —
  // must not throw (mirrors the node-runner fake hosts other widget tests
  // already use, which have none of these).
  const bareHost = { classList: { add() {}, remove() {} } };
  assert.doesNotThrow(() => {
    const h = createPaneContract(bareHost, () => {});
    h.dispose();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
