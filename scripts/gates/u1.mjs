#!/usr/bin/env node
// Gate U1 — the owner's data, catalogued where it is, Downloads first.
//
// U1's tests, then the U0 gate (the registry it offers from) and the S23 gate (S22, S21 and the panel:
// the catalogue it places, probes and queues).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[u1] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("U1 tests", [
  "--test",
  "tests/library_user_roots_test.mjs",
  "tests/drive_registry_test.mjs",
  "tests/estate_compare_test.mjs"
]);
run("u0 — the registry U1 offers from", ["scripts/gates/u0.mjs"]);
run("s23 — the librarian U1 queues, with s22, s21 and the panel inside it", ["scripts/gates/s23.mjs"]);

console.log(
  "[u1] the owner's data in their order, never Windows' own; one pass at a time; online-only never opened"
);
console.log("[u1] GATE GREEN");
