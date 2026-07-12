#!/usr/bin/env node
// Gate C1 — adaptive layout contract: panes genuinely fill the viewport.
// Hermetic: static file scan only, no services/network/preview. Exit 0 = pass.
// Spinning the full app at 3 resolutions is out of budget (see
// delivery/tasks/C1.md Handoff), so "graphs fill at 3 resolutions" is
// covered by static proxies for the WIRING that makes a canvas fill its
// pane (PaneContract, SVG width/height:100%, a clean min-height:0/
// min-width:0 ancestor chain) plus a MANUAL line for the human eyeball.
// "No widget sizes itself from the window" is fully automated.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WIDGETS_DIR = path.join(ROOT, "app", "L0", "_all", "mod", "_prime_silo", "widgets");
const PANE_CONTRACT_FILE = path.join(WIDGETS_DIR, "pane_contract.js");
const BRIDGE_CSS = path.join(ROOT, "app", "L0", "_all", "mod", "_prime_silo", "bridge", "bridge.css");
const LAYOUT_CSS = path.join(
  ROOT, "app", "L0", "_all", "mod", "_core", "framework", "css", "layout.css",
);

const failures = [];
function check(name, ok, detail = "") {
  console.log(`[c1] ${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}
function manual(note) {
  console.log(`[c1] MANUAL: ${note}`);
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "vendor" || entry.name === "node_modules") continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}
function toRel(p) {
  return path.relative(ROOT, p).replaceAll("\\", "/");
}
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

const widgetJsFiles = walk(WIDGETS_DIR).sort();

// Scoped to `window.innerWidth`/`.innerHeight` — a bare local `innerWidth` is fine.
const WINDOW_SIZE_RE = /\bwindow\.(innerWidth|innerHeight)\b/g;
const windowSizeViolations = [];
for (const file of widgetJsFiles) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    WINDOW_SIZE_RE.lastIndex = 0;
    if (WINDOW_SIZE_RE.test(line)) windowSizeViolations.push(`${toRel(file)}:${i + 1}`);
  });
}
check(
  "zero reads of window.innerWidth / window.innerHeight in widget sources",
  windowSizeViolations.length === 0,
  windowSizeViolations.join(", "),
);

// `.width =`/`.height =` on a canvas, minus force_graph_2d's documented
// fixed-chrome minimap exception, means the canvas won't track its pane.
const CANVAS_DIM_RE = /\b(\w+)\.(width|height)\s*=\s*\d+\s*;/;
const MINIMAP_EXCEPTION = {
  "app/L0/_all/mod/_prime_silo/widgets/force_graph_2d/index.js": ["cv.width = 210;", "cv.height = 140;"],
};
const canvasDimViolations = [];
for (const file of widgetJsFiles) {
  const rel = toRel(file);
  const exceptions = MINIMAP_EXCEPTION[rel] || [];
  fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const trimmed = line.trim();
      if (CANVAS_DIM_RE.test(trimmed) && !exceptions.includes(trimmed)) {
        canvasDimViolations.push(`${rel}:${i + 1} (${trimmed})`);
      }
    });
}
check(
  "no hardcoded canvas.width/canvas.height assignments outside the documented minimap exception",
  canvasDimViolations.length === 0,
  canvasDimViolations.join(", "),
);

// SVG widgets must let CSS override width/height:100% (viewBox scales to the
// pane, not the "tiny graph" bug's fixed layout size); host needs a definite height.
const SVG_WIDGETS = [
  { css: path.join(WIDGETS_DIR, "kg3d", "synoptic_web", "synoptic_web.css"), host: ".prime-silo-kg", svg: ".prime-silo-kg__svg" },
  { css: path.join(WIDGETS_DIR, "dag", "canvas", "canvas.css"), host: ".prime-silo-dag", svg: ".prime-silo-dag__svg" },
  { css: path.join(WIDGETS_DIR, "codegraph", "canvas", "canvas.css"), host: ".prime-silo-cg", svg: ".prime-silo-cg__svg" },
];
function ruleBody(text, cls) {
  const m = text.match(new RegExp(`(?:^|\\s)${cls.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "s"));
  return m ? m[1] : null;
}
for (const w of SVG_WIDGETS) {
  const rel = toRel(w.css);
  const text = fs.existsSync(w.css) ? stripComments(fs.readFileSync(w.css, "utf8")) : "";
  const svgBody = ruleBody(text, w.svg);
  check(
    `${rel} → ${w.svg} sets width:100% and height:100% (viewBox scales to pane)`,
    !!svgBody && /width\s*:\s*100%/.test(svgBody) && /height\s*:\s*100%/.test(svgBody),
    svgBody === null ? "rule not found" : "",
  );
  const hostBody = ruleBody(text, w.host);
  check(
    `${rel} → ${w.host} host resolves a definite height (height:100%)`,
    !!hostBody && /height\s*:\s*100%/.test(hostBody),
    hostBody === null ? "rule not found" : "",
  );
}

const paneContractExists = fs.existsSync(PANE_CONTRACT_FILE);
check("shared PaneContract helper exists (widgets/pane_contract.js)", paneContractExists);
if (paneContractExists) {
  check(
    "pane_contract.js exports createPaneContract(host, onResize, options)",
    /export function createPaneContract\s*\(/.test(fs.readFileSync(PANE_CONTRACT_FILE, "utf8")),
  );
}
for (const name of ["force_graph_2d", "three_renderer"]) {
  const file = path.join(WIDGETS_DIR, name, "index.js");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  check(
    `${toRel(file)} imports the shared PaneContract helper`,
    /from ["'].*pane_contract\.js["']/.test(text),
  );
}

// Ratchet (see c0.mjs): a literal width:/height:Npx on a pane/graph/stage/
// split selector defeats "fill the pane"; floor=0, chain was already clean.
// min-/max- props and grid-template px (sidebar rails) are excluded.
const PANE_CHAIN_SELECTOR_RE = /\b(pane|panes|graph|stage|split)\b/i;
const FIXED_DIM_RE = /(?<![\w-])(width|height)\s*:\s*\d+px\s*;/g;
const paneChainViolations = [];
for (const file of [BRIDGE_CSS, LAYOUT_CSS].filter((f) => fs.existsSync(f))) {
  const text = stripComments(fs.readFileSync(file, "utf8"));
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(text))) {
    const selector = m[1].trim();
    if (!PANE_CHAIN_SELECTOR_RE.test(selector)) continue;
    FIXED_DIM_RE.lastIndex = 0;
    let fm;
    while ((fm = FIXED_DIM_RE.exec(m[2]))) {
      paneChainViolations.push(`${toRel(file)} ${selector} {${fm[0].trim()}}`);
    }
  }
}
check(
  "no fixed px width/height on pane-ancestor selectors (floor=0)",
  paneChainViolations.length === 0,
  paneChainViolations.join("; "),
);

// Accepts the literal value or the `var(--pane-container-type[, …])` indirection.
const CONTAINER_TYPE_RE = /container-type\s*:\s*(inline-size|var\(--pane-container-type\b)/;
const layoutCssText = fs.existsSync(LAYOUT_CSS) ? fs.readFileSync(LAYOUT_CSS, "utf8") : "";
check(
  "layout.css defines a pane container-query hook (--pane-container-type: inline-size)",
  CONTAINER_TYPE_RE.test(layoutCssText),
);
const bridgeCssText = fs.existsSync(BRIDGE_CSS) ? fs.readFileSync(BRIDGE_CSS, "utf8") : "";
check(
  "bridge.css opts at least one real graph pane into container-query sizing",
  CONTAINER_TYPE_RE.test(bridgeCssText),
);
manual(
  "load Bridge + a graph view (kg3d/codegraph/dag/force_graph_2d) at 1280x800, " +
    "1920x1080, and 3840x2160 and confirm the canvas covers >=90% of its pane's " +
    "client box at each — the static checks above verify the WIRING that makes " +
    "this true (SVG scale-to-100%, definite-height hosts, debounced PaneContract " +
    "resize on the canvas/WebGL widgets, a min-height:0/min-width:0 ancestor " +
    "chain with zero px locks) but do not themselves render a page.",
);

console.log(
  failures.length === 0
    ? "[c1] GATE GREEN"
    : `[c1] GATE FAILED — ${failures.length} failing: ${failures.join("; ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
