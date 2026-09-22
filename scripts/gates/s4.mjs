#!/usr/bin/env node
// Gate S4 — the Estate Map panel.
//
// The panel's judgements are pure functions, so the tests can run them without a browser. What the
// gate adds on top is the two things a test of pure functions cannot see: that the panel is
// actually registered where the contract says, and that every helper the markup calls exists.
// A view that calls a function the script does not define renders blank, and a blank page and an
// empty estate look identical — which is the one failure this panel is built to avoid.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PANEL = path.join(ROOT, "app/L0/_all/mod/_prime_silo/estate_map");

for (const f of ["view.html", "estate_map.js", "estate_map.css", "fold_view.js", "ext/panels/estate_map.yaml"])
  if (!fs.existsSync(path.join(PANEL, f))) {
    console.error(`[s4] FAIL: the panel is missing ${f}`);
    process.exit(1);
  }

// Every x-* expression in the view that calls a helper must find it on the Alpine component.
const view = fs.readFileSync(path.join(PANEL, "view.html"), "utf8");
const js = fs.readFileSync(path.join(PANEL, "estate_map.js"), "utf8");
const called = new Set(
  [...view.matchAll(/(?:x-text|x-show|x-init|@click|:style|:data-\w+)="[^"]*?\b([a-z][\w$]*)\s*\(/gu)].map(
    (m) => m[1]
  )
);
const defined = new Set([
  ...[...js.matchAll(/^\s{4}(?:async\s+)?([a-z][\w$]*)\s*\(/gmu)].map((m) => m[1]),
  ...[...js.matchAll(/^\s{4}([a-z][\w$]*):\s/gmu)].map((m) => m[1])
]);
// What the view may legitimately call that is not the component's own: JS methods, the component
// factory, and Alpine's magics — $nextTick and friends, which the pattern above sees without their
// leading $. They are the framework's, and a panel that defined them would be the odd one.
const builtin = new Set([
  "toLocaleString",
  "join",
  "map",
  "filter",
  "estateMapPage",
  "nextTick",
  "watch",
  "dispatch"
]);
const missing = [...called].filter((c) => !defined.has(c) && !builtin.has(c));
if (missing.length) {
  console.error(`[s4] FAIL: view.html calls ${missing.join(", ")} — the panel defines no such helper`);
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "tests/estate_map_panel_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[s4] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[s4] a quiet node is stale and still drawn; a node that pushed no apps reads not-pushed; every byte in the treemap is accounted for"
);
console.log("[s4] GATE GREEN");
process.exit(0);
