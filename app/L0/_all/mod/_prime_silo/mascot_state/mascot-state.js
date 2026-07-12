// Benny mascot micro-states — idle / listening / processing (C5).
//
// `processing` is bound to REAL run activity: the app-wide activity store
// (runtime_client/activity-store.js), fed by the EventBus.subscribe_all SSE
// fan-in (GET /api/runtime/workflows/events). No setInterval/setTimeout
// here — state only ever changes on (1) a subscribeActivity() snapshot
// (running > 0 -> processing) or (2) real focusin/focusout on the composer
// input (-> listening).
//
// Animation itself lives in CSS (mod/_core/visual/mascot-motion.css), keyed
// off the `data-mascot-state` attribute this module sets. This module never
// touches animation/transform — reduced-motion/zen is a pure CSS concern.
//
// Scope note (delivery/tasks/C5.md "Run-specific facts"): the mascot markup
// (mod/_core/onscreen_agent/panel.html) is OUTSIDE this task's allowlist
// (_prime_silo/ + _core/visual/ only). This module finds its target by CSS
// selector so it CAN be imported from wherever the shell mounts, but
// nothing in-allowlist imports it yet — that wiring is blocked-scope. See
// the task handoff report.

const MASCOT_SELECTOR = ".onscreen-agent-avatar-button";
const INPUT_SELECTOR = ".onscreen-agent-composer-input-wrap textarea";

/** Pure derivation, no DOM/network. Real activity always outranks focus. */
export function deriveState({ running, focused }) {
  if (running) return "processing";
  if (focused) return "listening";
  return "idle";
}

/** Sets a data attribute; never touches style/animation directly. */
export function applyMascotState(el, state) {
  if (!el || !el.dataset) return;
  el.dataset.mascotState = state;
}

/**
 * Wires the mascot element to real activity + real focus events. Returns a
 * teardown function. Dependency-injectable (doc, subscribeActivity) so it
 * can be exercised in tests without a real DOM/network.
 */
export function initMascotState({
  doc = typeof document !== "undefined" ? document : null,
  subscribeActivity,
  mascotSelector = MASCOT_SELECTOR,
  inputSelector = INPUT_SELECTOR
} = {}) {
  if (!doc || typeof subscribeActivity !== "function") return () => {};

  let focused = false;
  let running = false;
  let observer = null;

  function render() {
    applyMascotState(doc.querySelector(mascotSelector), deriveState({ running, focused }));
  }

  function matchesInput(target) {
    return Boolean(target?.matches && target.matches(inputSelector));
  }
  function onFocusIn(event) {
    if (!matchesInput(event.target)) return;
    focused = true;
    render();
  }
  function onFocusOut(event) {
    if (!matchesInput(event.target)) return;
    focused = false;
    render();
  }

  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("focusout", onFocusOut, true);

  // Real activity only — no polling loop of our own; activity-store already
  // owns the SSE connection (+ its own honest poll fallback when SSE is down).
  const unsubscribeActivity = subscribeActivity((snapshot) => {
    running = Boolean(snapshot && snapshot.running > 0);
    render();
  });

  // The mascot mounts asynchronously (Alpine x-init in panel.html); observe
  // for it rather than assuming it exists when this is called.
  if (typeof MutationObserver !== "undefined" && doc.body) {
    observer = new MutationObserver(() => render());
    observer.observe(doc.body, { childList: true, subtree: true });
  }

  render();

  return function teardown() {
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("focusout", onFocusOut, true);
    if (typeof unsubscribeActivity === "function") unsubscribeActivity();
    if (observer) observer.disconnect();
  };
}
