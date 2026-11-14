#!/usr/bin/env node
// Gate S30 — a catalogue summarised before the folder weights existed still gets them.
//
// The first stop of the M13 walk-through, found on the real F:. Like S25 it adds no surface: it
// makes an existing one reachable, so its gate runs the library tests it lives in and the S26 chain
// that owns the folder routes, the panel and every surface they share files with. A green S30 that
// had broken the panel would be a gate reporting on code it never looked at.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[s30] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("S30 tests", ["--test", "tests/library_test.mjs"]);
run("s26 — the folder routes and the panel this shares its files with", ["scripts/gates/s26.mjs"]);

console.log(
  "[s30] a catalogue summarised before the rollup existed gets one without a new pass, because " +
    "the rollup's own key starts the worker as the summary's does; a catalogue already current " +
    "starts nothing; a 202 promises a minute only while a worker is building, and says the pass " +
    "is running when it is; a build that failed keeps its reason for a minute instead of being " +
    "retried away by the request that came to read it; and S25's two audit facts and two answer " +
    "fields are held by tests rather than by luck"
);
console.log("[s30] GATE GREEN");
