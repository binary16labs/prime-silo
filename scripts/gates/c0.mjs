#!/usr/bin/env node
// Gate C0 — design system contract: tokens + ADHD/Dyslexia rules as lint.
// Hermetic: static file scan only, no services, no network.
// Reports `[c0] GATE GREEN | GATE FAILED`; exit 0 = pass.
//
// Scans the governed scopes:
//   app/L0/_all/mod/_prime_silo/**/*.css
//   app/L0/_all/mod/_core/framework/css/**/*.css
// colors.css is the canonical token source and is exempt from the
// hex-literal rule (that's where hex is allowed to live).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Ratchet floor — recorded when this gate first went green. These are
// pre-existing hex literals in large, out-of-C0-budget module/widget CSS
// (bridge, lifelog, memory, memoray_client, widgets/*) that predate this
// contract; C0's allowlist doesn't cover them so they're grandfathered
// here rather than silently ignored. Any later commit may only shrink
// this list, never grow it (see the ratchet scenario below). Kept inline
// (not a separate file) so the floor stays inside c0.mjs, C0's sole
// allowlisted gate file.
const VIOLATION_FLOOR = {
  hexTotal: 119,
  hexByFile: {
    // chrome.css is outside C0's allowlist (not in the contract's file
    // list), so its 2 hex literals (--space-chrome-hover-bg/active-bg)
    // are grandfathered here rather than fixed in this task. Retheme
    // target for C1/module-retheming work.
    "app/L0/_all/mod/_core/framework/css/chrome.css": 2,
    "app/L0/_all/mod/_prime_silo/benny_record/benny_record.css": 1,
    "app/L0/_all/mod/_prime_silo/bridge/bridge.css": 27,
    "app/L0/_all/mod/_prime_silo/lifelog/lifelog.css": 17,
    "app/L0/_all/mod/_prime_silo/manifest_explorer/manifest-explorer.css": 2,
    "app/L0/_all/mod/_prime_silo/memoray_client/memoray-theme.css": 15,
    "app/L0/_all/mod/_prime_silo/memory/memory.css": 11,
    "app/L0/_all/mod/_prime_silo/mission_control/mission_control.css": 1,
    "app/L0/_all/mod/_prime_silo/session_graph/session_graph.css": 1,
    "app/L0/_all/mod/_prime_silo/setup/setup.css": 1,
    "app/L0/_all/mod/_prime_silo/step_through/step_through.css": 1,
    "app/L0/_all/mod/_prime_silo/widgets/codegraph/canvas/canvas.css": 3,
    "app/L0/_all/mod/_prime_silo/widgets/dag/canvas/canvas.css": 2,
    "app/L0/_all/mod/_prime_silo/widgets/force_graph_2d/force_graph_2d.css": 1,
    "app/L0/_all/mod/_prime_silo/widgets/kg3d/synoptic_web/synoptic_web.css": 3,
    "app/L0/_all/mod/_prime_silo/widgets/memoray/heatmap_radar/heatmap_radar.css": 16,
    "app/L0/_all/mod/_prime_silo/widgets/memoray/lineage_graph/lineage_graph.css": 5,
    "app/L0/_all/mod/_prime_silo/widgets/memoray/overview_cards/overview_cards.css": 9,
    "app/L0/_all/mod/_prime_silo/widgets/three_renderer/renderer.css": 1
  },
  justifyTotal: 0,
  baseFontTotal: 0
};

const GOVERNED_DIRS = [
  path.join(ROOT, "app", "L0", "_all", "mod", "_prime_silo"),
  path.join(ROOT, "app", "L0", "_all", "mod", "_core", "framework", "css")
];

const COLORS_CSS = path.join(
  ROOT,
  "app",
  "L0",
  "_all",
  "mod",
  "_core",
  "framework",
  "css",
  "colors.css"
);
const VISUAL_INDEX_CSS = path.join(
  ROOT,
  "app",
  "L0",
  "_all",
  "mod",
  "_core",
  "visual",
  "index.css"
);

const failures = [];
function check(name, ok, detail = "") {
  console.log(`[c0] ${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

function toRel(p) {
  return path.relative(ROOT, p).replaceAll("\\", "/");
}

const cssFiles = GOVERNED_DIRS.flatMap((d) => walk(d)).sort();

// Strip CSS comments so matches inside /* ... */ don't count.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

// ── Scenario: no hardcoded colors in governed CSS ──────────────────────────
// Hex color literals outside colors.css cause a non-zero exit (ratcheted —
// see the floor-file scenario below for the exact mechanism).
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const hexViolations = [];
for (const file of cssFiles) {
  if (path.resolve(file) === path.resolve(COLORS_CSS)) continue; // source of truth, exempt
  const text = stripComments(fs.readFileSync(file, "utf8"));
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const matches = line.match(HEX_RE);
    if (matches) {
      for (const m of matches) {
        hexViolations.push({ file: toRel(file), line: i + 1, match: m });
      }
    }
  });
}

// ── Scenario: dyslexia-friendly type rules are lintable ────────────────────
// text-align: justify anywhere in governed scope fails outright (floor is 0 —
// there is no legitimate justified body text in this design system).
const JUSTIFY_RE = /text-align\s*:\s*justify/gi;
const justifyViolations = [];
for (const file of cssFiles) {
  const text = stripComments(fs.readFileSync(file, "utf8"));
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (JUSTIFY_RE.test(line)) justifyViolations.push({ file: toRel(file), line: i + 1 });
    JUSTIFY_RE.lastIndex = 0;
  });
}
check(
  "dyslexia rule: no text-align: justify in governed CSS",
  justifyViolations.length === 0,
  justifyViolations.length ? justifyViolations.map((v) => `${v.file}:${v.line}`).join(", ") : ""
);

// Base font below 16px: the *document base* (html/body/:root font-size),
// not every chrome/label micro-size — those are legitimate UI chrome, the
// dyslexia rule targets body reading text. No base override currently
// exists in governed scope (inherits the 16px browser default), so this
// stays a hard "never introduce a base < 16px" rule (floor 0).
const BASE_SELECTOR_RE = /(^|\})\s*(html|body|:root)\s*(,[^{]*)?\{([^}]*)\}/gms;
const baseFontViolations = [];
for (const file of cssFiles) {
  const text = stripComments(fs.readFileSync(file, "utf8"));
  let m;
  BASE_SELECTOR_RE.lastIndex = 0;
  while ((m = BASE_SELECTOR_RE.exec(text))) {
    const body = m[4];
    const fsMatch = body.match(/font-size\s*:\s*([\d.]+)(px|rem|em|%)/i);
    if (!fsMatch) continue;
    const [, num, unit] = fsMatch;
    const px =
      unit === "px"
        ? parseFloat(num)
        : unit === "rem" || unit === "em"
          ? parseFloat(num) * 16
          : unit === "%"
            ? (parseFloat(num) / 100) * 16
            : NaN;
    if (px < 16) baseFontViolations.push({ file: toRel(file), value: `${num}${unit}` });
  }
}
check(
  "dyslexia rule: no document base font-size below 16px",
  baseFontViolations.length === 0,
  baseFontViolations.map((v) => `${v.file}: ${v.value}`).join(", ")
);

// ── Scenario: depth is restored via tokens ──────────────────────────────────
const visualIndexText = fs.existsSync(VISUAL_INDEX_CSS)
  ? stripComments(fs.readFileSync(VISUAL_INDEX_CSS, "utf8"))
  : "";
const hasBannedShadowReset = /box-shadow\s*:\s*none\s*!important/i.test(visualIndexText);
check("mod/_core/visual/index.css contains no box-shadow: none !important", !hasBannedShadowReset);

// framework css defines exactly 3 elevation tokens: --elevation-{1,2,3} (or
// named low/medium/high) declared once each in the framework/css scope.
const frameworkCssDir = path.join(ROOT, "app", "L0", "_all", "mod", "_core", "framework", "css");
const frameworkFiles = walk(frameworkCssDir);
const ELEVATION_TOKEN_RE = /--elevation-(\d+)\s*:/g;
const elevationTokensFound = new Set();
for (const file of frameworkFiles) {
  const text = stripComments(fs.readFileSync(file, "utf8"));
  let m;
  ELEVATION_TOKEN_RE.lastIndex = 0;
  while ((m = ELEVATION_TOKEN_RE.exec(text))) elevationTokensFound.add(m[1]);
}
check(
  "framework css defines exactly 3 elevation tokens (--elevation-1/2/3)",
  elevationTokensFound.size === 3,
  `found: ${[...elevationTokensFound].sort().join(",") || "none"}`
);

// ── Scenario + ratchet: violations ratchet down, never up ──────────────────
// The floor file records the violation count observed when this gate first
// went green for pre-existing, out-of-budget files. A later run may not
// exceed the recorded floor per rule; new files not in the floor's
// "grandfathered" list must be completely clean.
const floor = VIOLATION_FLOOR;

const hexTotal = hexViolations.length;
check(
  `hardcoded-color count at or below ratchet floor (floor=${floor.hexTotal})`,
  hexTotal <= floor.hexTotal,
  `current=${hexTotal}`
);

// Per-file: no file outside the floor's grandfathered set may introduce hex.
const hexByFile = {};
for (const v of hexViolations) hexByFile[v.file] = (hexByFile[v.file] || 0) + 1;
const newOffenders = Object.keys(hexByFile).filter(
  (f) => !Object.prototype.hasOwnProperty.call(floor.hexByFile || {}, f)
);
check(
  "no new files introduce hardcoded colors outside the grandfathered floor set",
  newOffenders.length === 0,
  newOffenders.join(", ")
);
// And grandfathered files may not get worse, only better or unchanged.
const worsenedOffenders = Object.keys(hexByFile).filter(
  (f) => (floor.hexByFile || {})[f] !== undefined && hexByFile[f] > floor.hexByFile[f]
);
check(
  "no grandfathered file's hardcoded-color count increased",
  worsenedOffenders.length === 0,
  worsenedOffenders.map((f) => `${f}: ${floor.hexByFile[f]} -> ${hexByFile[f]}`).join(", ")
);

check(
  `justify-violation count at or below ratchet floor (floor=${floor.justifyTotal})`,
  justifyViolations.length <= floor.justifyTotal,
  `current=${justifyViolations.length}`
);
check(
  `base-font-violation count at or below ratchet floor (floor=${floor.baseFontTotal})`,
  baseFontViolations.length <= floor.baseFontTotal,
  `current=${baseFontViolations.length}`
);

console.log(
  failures.length === 0
    ? "[c0] GATE GREEN"
    : `[c0] GATE FAILED — ${failures.length} failing: ${failures.join("; ")}`
);
process.exit(failures.length === 0 ? 0 : 1);
