#!/usr/bin/env node
// Gate N4 — cross-machine drift-delta engine. Pure functions; hermetic (no fs/net/hw).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mod = "server/coordination/lib/estate_drift.mjs";
if (!fs.existsSync(path.join(ROOT, mod))) {
  console.error(`[n4] FAIL: ${mod} missing`);
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "tests/estate_drift/estate_drift.test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[n4] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[n4] drift-delta: content-hash delta hub<-satellite, overlap excluded, quarantine counted-never-surfaced (R31), execution drift — green"
);
console.log("[n4] GATE GREEN");
process.exit(0);
