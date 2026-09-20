#!/usr/bin/env node
// Gate S2 — applications, services, scheduled tasks and ports.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = "server/coordination/lib/estate_map_apps.mjs";
if (!fs.existsSync(path.join(ROOT, LIB))) {
  console.error(`[s2] FAIL: ${LIB} missing`);
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "tests/estate_map_apps_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[s2] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[s2] six sources, each failing alone and loudly; two sources naming one product fold to one app"
);
console.log("[s2] GATE GREEN");
process.exit(0);
