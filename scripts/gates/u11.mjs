#!/usr/bin/env node
// Gate U11 — a drive's comings and goings reach the ledger, and an unplugged drive keeps its date.
//
// It runs U0's gate inside itself, which runs S21's: U11 changes where a catalogue's file name is
// spelled, and if that moved by a byte every catalogue the owner has would be orphaned under a name
// nothing looks for. And it runs the panel's tests, because the three catalogue states are only
// worth having if the Drives tab shows them apart.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[u11] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("U11 tests and the panel", [
  "--test",
  "tests/drive_registry_test.mjs",
  "tests/library_test.mjs",
  "tests/estate_map_panel_test.mjs"
]);
run("u0 — the registry, with s21 and the identity every catalogue is named for", [
  "scripts/gates/u0.mjs"
]);

console.log(
  "[u11] plugging a drive in and taking it out both reach the ledger, through the real append, " +
    "with the drive's identity and never its label; an unplugged drive's catalogue is found by the " +
    "identity the registry kept, through the one spelling of a catalogue's file name; the Drives tab " +
    "says a date, never catalogued, or cannot tell, and with the store's own drive away it calls no " +
    "drive never catalogued; and the drives route closes every catalogue it opens"
);
console.log("[u11] GATE GREEN");
