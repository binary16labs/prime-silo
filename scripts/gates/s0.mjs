#!/usr/bin/env node
// Gate S0 — estate map model: local index, collector interface, snapshot to CAS + sweep_recorded.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mod = "server/coordination/lib/estate_map.mjs";
if (!fs.existsSync(path.join(ROOT, mod))) {
  console.error(`[s0] FAIL: ${mod} missing`);
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "tests/estate_map_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[s0] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[s0] estate map: per-collector status + scope travel with the sweep, quarantined paths hashed before any write (R31), snapshot in CAS named by sweep_recorded — green"
);
console.log("[s0] GATE GREEN");
process.exit(0);
