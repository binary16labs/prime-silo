#!/usr/bin/env node
// Gate L6 — authorship provenance + record-served tagging (capture-time). Hermetic: repo + fixtures.
// Contract: delivery/tasks/L6.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (!fs.existsSync(path.join(ROOT, "server/coordination/lib/authorship.mjs"))) {
  console.error("[l6] FAIL: required artifact missing: server/coordination/lib/authorship.mjs");
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "tests/authorship/authorship_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[l6] GATE FAILED (authorship scenarios)");
  process.exit(1);
}

console.log("[l6] authorship: capture-time tagging + untagged-reject + served pointer verified");
console.log("[l6] GATE GREEN");
process.exit(0);
