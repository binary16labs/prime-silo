#!/usr/bin/env node
// Gate L1 — portable CAS staging on D: (blobs + human-navigable index + self-describing
// manifest), de-dup, plug-and-play. Hermetic: repo files + a temp-dir fixture only (no real D:).
// Spec: architecture/SPEC-knowledge-eventlog.md (§ Staging) · Contract: delivery/tasks/L1.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const need = [
  "architecture/SPEC-knowledge-eventlog.md",
  "server/coordination/lib/staging.mjs"
];
for (const f of need) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error(`[l1] FAIL: required artifact missing: ${f}`);
    process.exit(1);
  }
}

const t = spawnSync(process.execPath, ["--test", "tests/staging/staging_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[l1] GATE FAILED (staging scenarios)");
  process.exit(1);
}

console.log("[l1] staging: CAS de-dup + self-describing index + plug-and-play manifest verified");
console.log("[l1] GATE GREEN");
process.exit(0);
