#!/usr/bin/env node
// Gate L14 — compound-value triad dashboard.
// The triad (held-out eval delta + agent pass-rate + cost/task) is shown as THREE series over loop
// turns, never a single gameable composite; a non-improving turn is shown + flagged, not hidden; each
// point traces to the executions.jsonl records it summarizes; the view is a pure function of the
// register. Hermetic: pure lib unit tests + a temp register. Contract: delivery/tasks/L14.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const rel of ["server/coordination/lib/triad_dashboard.mjs", "server/pages/flywheel.html"]) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error(`[l14] FAIL: required artifact missing: ${rel}`);
    process.exit(1);
  }
}

const t = spawnSync(
  process.execPath,
  ["--test", "tests/triad_dashboard/triad_dashboard_test.mjs"],
  {
    cwd: ROOT,
    stdio: "inherit"
  }
);
if (t.status !== 0) {
  console.log("[l14] GATE FAILED (triad dashboard scenarios)");
  process.exit(1);
}

console.log(
  "[l14] triad: three series (no composite) + honest-negative shown/flagged + auditable points + deterministic render verified"
);
console.log("[l14] GATE GREEN");
process.exit(0);
