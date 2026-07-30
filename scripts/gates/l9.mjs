#!/usr/bin/env node
// Gate L9 — privacy-honoring history + keep-both-and-flag conflict.
// Teleport exclusion across all bi-temporal time; reversible tombstone (journalled, not erased);
// contradictory facts kept-both-and-flagged with a conflict_flagged review event (never auto-picked).
// Hermetic: repo files + temp fixtures only. Contract: delivery/tasks/L9.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const rel of [
  "server/coordination/lib/privacy_history.mjs",
  "server/coordination/lib/projector.mjs"
]) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error(`[l9] FAIL: required artifact missing: ${rel}`);
    process.exit(1);
  }
}

const t = spawnSync(
  process.execPath,
  ["--test", "tests/privacy_history/privacy_history_test.mjs"],
  {
    cwd: ROOT,
    stdio: "inherit"
  }
);
if (t.status !== 0) {
  console.log("[l9] GATE FAILED (privacy / conflict scenarios)");
  process.exit(1);
}

console.log(
  "[l9] privacy: teleport-exclusion across all time + reversible tombstone + keep-both-and-flag conflict verified"
);
console.log("[l9] GATE GREEN");
process.exit(0);
