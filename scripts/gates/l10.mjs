#!/usr/bin/env node
// Gate L10 — flywheel daemon (trigger + liveness).
// Reactive + cron triggers both take the L7 single-winner claim; a wedge is detected by RESOURCE
// (flat CPU-time / stale artifacts / stale heartbeat), never by log lines; the dead-man switch aborts
// clean (stops the job, releases the lease, emits run_failed, alerts).
// Hermetic: repo files + temp fixtures only. Contract: delivery/tasks/L10.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const rel of [
  "server/coordination/lib/flywheel_daemon.mjs",
  "server/coordination/lib/liveness.mjs"
]) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error(`[l10] FAIL: required artifact missing: ${rel}`);
    process.exit(1);
  }
}

const t = spawnSync(process.execPath, ["--test", "tests/flywheel_daemon/flywheel_daemon_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[l10] GATE FAILED (daemon / liveness scenarios)");
  process.exit(1);
}

console.log("[l10] daemon: reactive+cron trigger under L7 claim + resource-not-log wedge detection + clean dead-man abort verified");
console.log("[l10] GATE GREEN");
process.exit(0);
