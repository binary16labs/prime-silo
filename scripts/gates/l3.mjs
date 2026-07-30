#!/usr/bin/env node
// Gate L3 — durability of the portable substrate (replicate + checksum integrity + restore drill).
// Hermetic: repo files + temp fixtures only. Contract: delivery/tasks/L3.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const need = ["server/coordination/lib/durability.mjs", "docs/operations/FLYWHEEL-DURABILITY.md"];
for (const f of need) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error(`[l3] FAIL: required artifact missing: ${f}`);
    process.exit(1);
  }
}

const t = spawnSync(process.execPath, ["--test", "tests/durability/durability_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[l3] GATE FAILED (durability scenarios)");
  process.exit(1);
}

console.log("[l3] durability: replicate + checksum-integrity + restore-drill verified");
console.log("[l3] GATE GREEN");
process.exit(0);
