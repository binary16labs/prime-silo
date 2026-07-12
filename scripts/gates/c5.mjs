#!/usr/bin/env node
// Gate C5 — Benny mascot micro-states (idle/listening/processing).
// Hermetic: static file scan + `node --test` against a mocked SSE transport,
// no live services, no network, no browser.
//
// Checks:
//   1. mascot-motion.css defines the three state keyframes.
//   2. mascot-motion.css has a prefers-reduced-motion guard AND a
//      [data-profile="zen"] guard that both force `animation: none !important`.
//   3. mascot-motion.css is actually wired in (imported by visual/index.css),
//      not an orphaned file nobody loads.
//   4. Neither the CSS nor mascot-state.js contains a timer-driven state
//      (no setInterval anywhere; setTimeout may appear only in tests, never
//      in the shipped binding module).
//   5. `deriveState`/`applyMascotState`/`initMascotState` are exported (the
//      binding module's actual contract).
//   6. The DOM scenario tests pass: idle -> processing -> idle against a
//      mocked SSE transport, and reduced-motion is honored by the CSS
//      analyzed in (2) — see tests/mascot_state_test.mjs for the exact
//      assertions this gate calls into.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const failures = [];
function check(name, ok, detail = "") {
  console.log(`[c5] ${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const CSS_PATH = path.join(ROOT, "app", "L0", "_all", "mod", "_core", "visual", "mascot-motion.css");
const JS_PATH = path.join(
  ROOT,
  "app",
  "L0",
  "_all",
  "mod",
  "_prime_silo",
  "mascot_state",
  "mascot-state.js"
);
const INDEX_CSS_PATH = path.join(ROOT, "app", "L0", "_all", "mod", "_core", "visual", "index.css");
const TEST_PATH = path.join(ROOT, "tests", "mascot_state_test.mjs");

// ── Scenario: files exist ───────────────────────────────────────────────────
const cssExists = fs.existsSync(CSS_PATH);
check("mascot-motion.css exists", cssExists, path.relative(ROOT, CSS_PATH));
const jsExists = fs.existsSync(JS_PATH);
check("mascot-state.js exists", jsExists, path.relative(ROOT, JS_PATH));

const css = cssExists ? fs.readFileSync(CSS_PATH, "utf8") : "";
const js = jsExists ? fs.readFileSync(JS_PATH, "utf8") : "";
const indexCss = fs.existsSync(INDEX_CSS_PATH) ? fs.readFileSync(INDEX_CSS_PATH, "utf8") : "";

// ── Scenario: three state keyframes are defined ─────────────────────────────
const keyframeNames = ["idle", "listening", "processing"];
for (const state of keyframeNames) {
  const re = new RegExp(`@keyframes\\s+benny-${state}`, "i");
  check(`keyframe for "${state}" state defined`, re.test(css));
}

// ── Scenario: each state selector actually applies an animation ────────────
for (const state of keyframeNames) {
  const re = new RegExp(
    `\\[data-mascot-state="${state}"\\][^{]*\\{[^}]*animation\\s*:`,
    "s"
  );
  check(`data-mascot-state="${state}" selector applies an animation`, re.test(css));
}

// ── Scenario: reduced motion is respected (hard gate, no exceptions) ───────
const reducedMotionBlockRe = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([^]*?)\}\s*\}/;
const reducedMotionMatch = css.match(reducedMotionBlockRe);
check(
  "prefers-reduced-motion: reduce block present",
  Boolean(reducedMotionMatch)
);
check(
  "prefers-reduced-motion block forces animation: none !important",
  Boolean(reducedMotionMatch && /animation\s*:\s*none\s*!important/.test(reducedMotionMatch[1]))
);

// ── Scenario: zen profile is respected (same hard gate) ────────────────────
const zenBlockRe = /\[data-profile="zen"\][^{]*\{([^}]*)\}/;
const zenMatch = css.match(zenBlockRe);
check('[data-profile="zen"] rule present', Boolean(zenMatch));
check(
  '[data-profile="zen"] rule forces animation: none !important',
  Boolean(zenMatch && /animation\s*:\s*none\s*!important/.test(zenMatch[1]))
);

// ── Scenario: the CSS is actually loaded, not orphaned ──────────────────────
check(
  "mascot-motion.css is imported by visual/index.css (which onscreen_agent/panel.html links)",
  /@import\s+["']\.\/mascot-motion\.css["']/.test(indexCss)
);

// ── Scenario: no timer pretends to be activity ──────────────────────────────
check(
  "mascot-state.js contains no setInterval (state must trace to a real event)",
  !/setInterval\s*\(/.test(js)
);
check(
  "mascot-state.js contains no setTimeout (no fake/delayed activity either)",
  !/setTimeout\s*\(/.test(js)
);
check(
  "mascot-motion.css keyframes use finite/real durations (no 0s or negative durations)",
  !/animation\s*:[^;]*\b0s\b/.test(css)
);

// ── Scenario: binding module exports its real contract ─────────────────────
for (const fn of ["deriveState", "applyMascotState", "initMascotState"]) {
  check(`mascot-state.js exports ${fn}`, new RegExp(`export function ${fn}`).test(js));
}

// ── Scenario: processing is bound to the real activity-store (not invented) ─
check(
  "mascot-state.js is wired to subscribeActivity (dependency-injected, not a homemade poller)",
  /subscribeActivity/.test(js)
);

if (failures.length > 0) {
  console.log(`[c5] GATE FAILED (static) — ${failures.length} failing: ${failures.join("; ")}`);
  process.exit(1);
}

// ── Scenario: idle -> processing -> idle DOM test against mocked SSE ───────
if (!fs.existsSync(TEST_PATH)) {
  console.log(`[c5] FAIL — ${path.relative(ROOT, TEST_PATH)} missing`);
  console.log("[c5] GATE FAILED");
  process.exit(1);
}
const t = spawnSync(process.execPath, ["--test", "tests/mascot_state_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[c5] GATE FAILED (DOM scenario test)");
  process.exit(1);
}

console.log("[c5] GATE GREEN");
process.exit(0);
