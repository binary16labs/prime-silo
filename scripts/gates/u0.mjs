#!/usr/bin/env node
// Gate U0 — the drive registry: every drive by identity, never by letter.
//
// It runs the S21 gate inside itself because U0 changed where identity LIVES: rootIdentity now
// delegates to driveIdentity, and if that moved Windows' value by a byte then every catalogue the
// owner has — including the 1.1-million-file F: — would be orphaned under a name nothing looks for.
// S20's and S22's compare tests are the only thing that proves it did not, so a green U0 that had
// not run them would be a gate reporting success about the one risk this contract carries.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[u0] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("U0 tests", ["--test", "tests/drive_registry_test.mjs", "tests/estate_compare_test.mjs"]);
run("s21 — the identity every catalogue is named for, and the estate API it shares", [
  "scripts/gates/s21.mjs"
]);

console.log(
  "[u0] a drive is what it IS, not the letter it took: the same disk at another letter is the same " +
    "row with one attached event, an unplugged drive is remembered rather than forgotten, and an " +
    "unreadable identity is never merged with another drive's facts; Windows identity is " +
    "byte-identical to S21's, so every catalogue still finds its own drive; the registry lives on " +
    "the machine because F: comes and goes; a volume label and a name the owner types are both " +
    "their own text and both read 'label withheld' when a rule matches; and on the system drive it " +
    "is the user's own folders that are offered, where they really are, never the drive whole and " +
    "never Windows, Program Files, ProgramData or AppData"
);
console.log("[u0] GATE GREEN");
