#!/usr/bin/env node
// Gate N5 — governed approve-to-sync. Pure logic over injected deps; hermetic (spy syncSource/bus).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const mod of ["server/coordination/lib/estate_govern.mjs"]) {
  if (!fs.existsSync(path.join(ROOT, mod))) {
    console.error(`[n5] FAIL: ${mod} missing`);
    process.exit(1);
  }
}

const t = spawnSync(process.execPath, ["--test", "tests/estate_govern/estate_govern.test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[n5] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[n5] approve-to-sync: no sync without an owner signature, clean-only + idempotent apply via syncSource, quarantine never in a proposal (R31), additive route — green"
);
console.log("[n5] GATE GREEN");
process.exit(0);
