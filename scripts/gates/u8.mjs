#!/usr/bin/env node
// Gate U8 — the signed copy: read back, never overwriting, never touching the source.
// U8 tests and the panel, then the U7 gate (u6, u12, u1, u0, s23 and everything inside it).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[u8] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("U8 tests", ["--test", "tests/estate_copy_test.mjs", "tests/estate_map_panel_test.mjs"]);
run("u7 — the signed plan U8 carries out", ["scripts/gates/u7.mjs"]);

console.log("[u8] only a current, human-signed plan runs: staged by robocopy, read back by sha256, linked into place, never overwriting; cloud-only never opened; one run record, counts only");
console.log("[u8] GATE GREEN");
