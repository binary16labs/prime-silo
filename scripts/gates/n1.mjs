#!/usr/bin/env node
// Gate N1 — estate probes (topology, drift, metrics). Pure functions; hermetic.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mod = "server/coordination/lib/estate_probe.mjs";
if (!fs.existsSync(path.join(ROOT, mod))) {
  console.error(`[n1] FAIL: ${mod} missing`);
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "tests/estate_probe/estate_probe.test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[n1] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[n1] estate probes: drift verdicts, hub/satellite topology, resource-liveness, quarantine-excluded stats — green"
);
console.log("[n1] GATE GREEN");
process.exit(0);
