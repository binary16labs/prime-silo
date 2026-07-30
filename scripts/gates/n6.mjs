#!/usr/bin/env node
// Gate N6 — next-cycle flywheel planner. Pure projection over fixtures; hermetic (no fs/net/LM).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mod = "server/coordination/lib/estate_plan.mjs";
if (!fs.existsSync(path.join(ROOT, mod))) {
  console.error(`[n6] FAIL: ${mod} missing`);
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "tests/estate_plan/estate_plan.test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[n6] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[n6] planner: drift->cards->Stream-A rows, rebuild-threshold crossing, read-only projection shared with the flywheel, additive route — green"
);
console.log("[n6] GATE GREEN");
process.exit(0);
