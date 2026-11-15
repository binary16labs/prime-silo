#!/usr/bin/env node
// Gate U12 — Check and Compare never open a file that is only in the cloud.
// U12's tests, then the U1 gate (u0, s23 and everything inside: the catalogue and routes U12 guards).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[u12] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("U12 tests", ["--test", "tests/library_user_roots_test.mjs"]);
run("u1 — the catalogue and routes U12 guards", ["scripts/gates/u1.mjs"]);

console.log("[u12] a check or comparison that would reach into OneDrive is refused; a check probes what it is asked about and never opens a cloud-only file");
console.log("[u12] GATE GREEN");
