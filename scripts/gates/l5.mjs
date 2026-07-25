#!/usr/bin/env node
// Gate L5 — unified execution register (executions.jsonl): one queryable, rebuildable JSONL
// projection folding the four existing logs. Hermetic: repo files + fixtures. Contract: delivery/tasks/L5.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (!fs.existsSync(path.join(ROOT, "server/coordination/lib/exec_register.mjs"))) {
  console.error("[l5] FAIL: required artifact missing: server/coordination/lib/exec_register.mjs");
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "tests/exec_register/exec_register_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[l5] GATE FAILED (execution-register scenarios)");
  process.exit(1);
}

console.log("[l5] register: four-log fold + cross-machine compare + rebuildable projection verified");
console.log("[l5] GATE GREEN");
process.exit(0);
