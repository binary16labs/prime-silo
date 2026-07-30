#!/usr/bin/env node
// Gate L13 — promotion decision function + additive eval growth.
// "N+1 ≥ N" is an explicit dominance/eval-anchored rule over the metric vector (deterministic on
// Pareto trade-offs), and the held-out instrument grows additively — a new slice never rewrites a
// historical turn's score; cross-turn comparisons use only slices present in both turns.
// Hermetic: pure lib unit tests. Contract: delivery/tasks/L13.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const rel of [
  "server/coordination/lib/promotion_rule.mjs",
  "scripts/train/eval/slices/slices.json"
]) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error(`[l13] FAIL: required artifact missing: ${rel}`);
    process.exit(1);
  }
}

const t = spawnSync(process.execPath, ["--test", "tests/promotion_rule/promotion_rule_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[l13] GATE FAILED (decision-rule / additive-eval scenarios)");
  process.exit(1);
}

console.log(
  "[l13] rule: dominance + eval-anchored Pareto (deterministic) + additive eval growth (history frozen) verified"
);
console.log("[l13] GATE GREEN");
process.exit(0);
