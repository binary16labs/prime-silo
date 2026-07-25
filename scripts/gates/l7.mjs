#!/usr/bin/env node
// Gate L7 — single-winner loop claim (reuses the B0 wx-lease) + journalled compaction + storage budget.
// Hermetic: repo files + temp fixtures. Contract: delivery/tasks/L7.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const need = ["server/coordination/lib/loop_claim.mjs", "server/coordination/lib/compaction.mjs"];
for (const f of need) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error(`[l7] FAIL: required artifact missing: ${f}`);
    process.exit(1);
  }
}

const t = spawnSync(process.execPath, ["--test", "tests/loop_claim/loop_claim_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[l7] GATE FAILED (loop-claim/compaction scenarios)");
  process.exit(1);
}

console.log("[l7] single-winner claim + journalled compaction + storage budget verified");
console.log("[l7] GATE GREEN");
process.exit(0);
