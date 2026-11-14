#!/usr/bin/env node
// Gate S23 — Everything lists the drive, the walk is the fallback, and the catalogue keeps itself current.
//
// It runs S23's own tests, then the S22 gate (which runs S21's: the catalogue S23 changes) and the S1
// gate (the Everything adapter S23 lists with). A green S23 that had broken the catalogue's walk, its
// removal rule or the adapter would be a gate reporting on code it never looked at.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[s23] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("S23 tests", [
  "--test",
  "tests/library_test.mjs",
  "tests/library_rescan_test.mjs",
  "tests/estate_map_panel_test.mjs"
]);
run("s22 — the librarian, with s21's catalogue inside it", ["scripts/gates/s22.mjs"]);
run("s1 — the Everything adapter S23 lists with", ["scripts/gates/s1.mjs"]);

console.log(
  "[s23] a pass lists the drive with Everything when it can and walks when it cannot, with one set of " +
    "exclusions so both make the same catalogue; an unchanged listed file is neither looked at nor read; a " +
    "listing that fails, holds under 99% of the catalogue, or comes too long after the last walk walks " +
    "instead and says why; each pass records how it listed and who started it; and the hub rescans each " +
    "attached, already-catalogued drive on the owner's interval through its one librarian, never a drive " +
    "that is absent or different"
);
console.log("[s23] GATE GREEN");
