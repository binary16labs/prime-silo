#!/usr/bin/env node
// Gate S31 — opening the top of a drive never scans it on the hub's thread.
//
// The next walk-through stop after S30, in the very thing S30 made reachable. Like S30 it adds no
// surface, so its gate runs the library tests it lives in and S30's gate, which runs the S26 chain
// that owns the folder routes and the panel.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[s31] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("S31 tests", ["--test", "tests/library_test.mjs"]);
run("s30 — the folder figures, and the S26 chain inside it", ["scripts/gates/s30.mjs"]);

console.log(
  "[s31] a catalogue older than the root index gets it from the folder worker, off the hub's " +
    "thread, without a new pass and without its rollup or summary being redone; until it has it " +
    "the top folder says it is being worked out rather than sorting every file on the drive; and " +
    "the index is spelled once, whether the schema or the worker makes it"
);
console.log("[s31] GATE GREEN");
