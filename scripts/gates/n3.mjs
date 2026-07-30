#!/usr/bin/env node
// Gate N3 — drill-down cards + board & LONGVIEW tie-in. Hermetic.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = (m) => {
  console.error(`[n3] FAIL: ${m}`);
  process.exit(1);
};

for (const f of ["server/coordination/lib/estate_api.mjs", "server/pages/estate.html"])
  if (!fs.existsSync(path.join(ROOT, f))) fail(`${f} missing`);

const t = spawnSync(process.execPath, ["--test", "tests/estate3/estate3.test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[n3] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[n3] board lane + quarantine-safe drill-down + real-or-null LONGVIEW dial + page wiring — green"
);
console.log("[n3] GATE GREEN");
process.exit(0);
