#!/usr/bin/env node
// Gate L0 — knowledge event log (KEL): envelope schema + tamper-evident chain +
// fold-to-projection + versioned up-converter registry. Hermetic: repo files only.
// Spec: architecture/SPEC-knowledge-eventlog.md · Contract: delivery/tasks/L0.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// 1. Required artifacts exist (the substrate's constitution must be present).
const need = [
  "architecture/SPEC-knowledge-eventlog.md",
  "server/coordination/schema/kel-event.schema.json",
  "server/coordination/lib/kel.mjs"
];
for (const f of need) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error(`[l0] FAIL: required artifact missing: ${f}`);
    process.exit(1);
  }
}

// 2. Acceptance scenarios (behavioural — the KEL doctrine holds).
const t = spawnSync(process.execPath, ["--test", "tests/kel/kel_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[l0] GATE FAILED (KEL scenarios)");
  process.exit(1);
}

console.log("[l0] KEL: envelope + chain + bi-temporal fold + converters verified");
console.log("[l0] GATE GREEN");
process.exit(0);
