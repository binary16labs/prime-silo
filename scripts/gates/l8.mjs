#!/usr/bin/env node
// Gate L8 — bi-temporal projectors + time-travel query.
// Rebuild-from-log identity, valid-time + txn-time query, corpus reconstruction via
// knowledge_watermark, incremental reprojection via L4 cursors.
// Hermetic: repo files + temp fixtures only. Contract: delivery/tasks/L8.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const rel of [
  "server/coordination/lib/projector.mjs",
  "server/coordination/lib/timetravel.mjs"
]) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error(`[l8] FAIL: required artifact missing: ${rel}`);
    process.exit(1);
  }
}

const t = spawnSync(process.execPath, ["--test", "tests/projector/projector_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[l8] GATE FAILED (projector / time-travel scenarios)");
  process.exit(1);
}

console.log(
  "[l8] projector: rebuild-from-log identity + valid/txn time-travel + corpus reconstruction + incremental reprojection verified"
);
console.log("[l8] GATE GREEN");
process.exit(0);
