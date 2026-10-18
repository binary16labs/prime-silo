#!/usr/bin/env node
// Gate S21 — the librarian: a catalogue of F: that every question is asked of.
//
// The catalogue's own tests, then the comparison's (S20's scenarios, and S21's "compared without
// reading F:" and "changed since catalogued"), then the F:\nas catalogue and itinerary tests, which
// must not change (design point 7). Last, the S20 gate, because S21 adds routes to the same estate
// API and a tab to the same panel: it runs S17's, which boots the hub three ways.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" }).status;

for (const [file, what] of [
  ["tests/library_test.mjs", "the catalogue's own scenarios"],
  ["tests/estate_compare_test.mjs", "the comparison against the catalogue"],
  ["tests/nas_catalog_test.mjs", "the F:\\nas catalogue, which S21 must leave as it was"],
  ["tests/nas_itinerary_test.mjs", "the F:\\nas itinerary, which S21 must leave as it was"]
]) {
  if (run(["--test", file]) !== 0) {
    console.error(`[s21] FAIL: ${what}`);
    process.exit(1);
  }
}
if (run([path.join(ROOT, "scripts", "gates", "s20.mjs")]) !== 0) {
  console.error("[s21] FAIL: the S20 gate, which shares S21's estate API and panel");
  process.exit(1);
}
console.log(
  "[s21] F: is catalogued once in folder order, resumes after a stop and never forgets what it has not reached; duplicates and backups are asked of the catalogue, not the disk; private files are counted, never named"
);
console.log("[s21] GATE GREEN");
