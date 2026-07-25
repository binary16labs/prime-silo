#!/usr/bin/env node
// Gate L2 — inbound poison gate (integrity boundary at admission, symmetric to the outbound leak gate).
// Hermetic: repo files + temp fixtures only. Contract: delivery/tasks/L2.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (!fs.existsSync(path.join(ROOT, "server/coordination/lib/poison_gate.mjs"))) {
  console.error("[l2] FAIL: required artifact missing: server/coordination/lib/poison_gate.mjs");
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "tests/poison/poison_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[l2] GATE FAILED (poison-gate scenarios)");
  process.exit(1);
}

console.log("[l2] poison gate: hash-integrity + injection + shape checks verified");
console.log("[l2] GATE GREEN");
process.exit(0);
