#!/usr/bin/env node
// Gate C8 — the Drives tab, drawn as a blueprint.
//
// A restyle of one tab, so its gate runs what that tab's correctness lives in: the panel's own
// rendered tests (which include the stylesheet inventory that refuses anything that clips), the C0
// design-system gate (no colour outside colors.css, no justify, no small body text), and U11's gate,
// which owns the Drives tab's data and runs U0 and S21 inside it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[c8] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("C8 rendered tests and the panel", ["--test", "tests/estate_map_panel_test.mjs"]);
run("c0 — the design system", ["scripts/gates/c0.mjs"]);
run("u11 — the Drives tab's data, with u0 and s21 inside it", ["scripts/gates/u11.mjs"]);

console.log(
  "[c8] each drive is an elevation drawing whose filled share is its real use, said in words and " +
    "in its accessible name; a figure the OS did not give is drawn as unknown, never a guessed bar; " +
    "a drive 90% full or more takes the danger token; an unplugged drive stays on the sheet, dimmed; " +
    "the system drive's folders are a list with Downloads first; and nothing on the tab moves"
);
console.log("[c8] GATE GREEN");
