#!/usr/bin/env node
// Gate S1 — file collectors: MFT-fast adapters, walker fallback, benchmark decision.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const f of ["server/coordination/lib/estate_map_files.mjs", "scripts/estate_map_bench.mjs"])
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error(`[s1] FAIL: ${f} missing`);
    process.exit(1);
  }

const t = spawnSync(process.execPath, ["--test", "tests/estate_map_files_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[s1] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[s1] adapters give identical rows; walker fallback recorded; bench never picks a slower one"
);
console.log("[s1] GATE GREEN");
process.exit(0);
