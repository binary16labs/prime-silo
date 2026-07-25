#!/usr/bin/env node
// Gate L4 — delta engine (per-content-hash cursors): idempotent, resumable, order-tolerant.
// Hermetic: repo files + temp fixtures only. Contract: delivery/tasks/L4.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (!fs.existsSync(path.join(ROOT, "server/coordination/lib/delta.mjs"))) {
  console.error("[l4] FAIL: required artifact missing: server/coordination/lib/delta.mjs");
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "tests/delta/delta_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[l4] GATE FAILED (delta scenarios)");
  process.exit(1);
}

console.log("[l4] delta: per-content-hash cursors — skip/idempotent/resume/order-tolerant verified");
console.log("[l4] GATE GREEN");
process.exit(0);
