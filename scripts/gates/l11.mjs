#!/usr/bin/env node
// Gate L11 — model-collapse guard (verifier gate + house-fraction cap).
// House-authored sessions train only after a verifier pass; house-origin rows are fraction-capped per
// turn; human/frontier rows are never capped. Includes the NEGATIVE case (unverified house row leaking
// into training → RED). Hermetic: pure lib unit tests. Contract: delivery/tasks/L11.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (!fs.existsSync(path.join(ROOT, "scripts/train/lib/authorship_cap.mjs"))) {
  console.error("[l11] FAIL: required artifact missing: scripts/train/lib/authorship_cap.mjs");
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "scripts/train/tests/authorship_cap_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[l11] GATE FAILED (collapse-guard scenarios)");
  process.exit(1);
}

console.log(
  "[l11] guard: verifier-gate (unverified house excluded) + per-turn house-fraction cap (human/frontier uncapped) verified"
);
console.log("[l11] GATE GREEN");
process.exit(0);
