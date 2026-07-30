#!/usr/bin/env node
// Gate N0 — estate model + delta sync engine. Runs the BDD scenarios and a structural
// check that the reuse contract holds (no rebuilt storage layer). Hermetic: repo only.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = (m) => {
  console.error(`[n0] FAIL: ${m}`);
  process.exit(1);
};

// 1. modules exist
for (const f of ["server/coordination/lib/estate.mjs", "server/coordination/lib/estate_sync.mjs"])
  if (!fs.existsSync(path.join(ROOT, f))) fail(`${f} missing`);

// 2. reuse contract: the sync engine composes L1/L4/L0, it does not reimplement them
const sync = fs.readFileSync(path.join(ROOT, "server/coordination/lib/estate_sync.mjs"), "utf8");
for (const [needle, why] of [
  ["casStore", "must reuse L1 CAS staging for content dedup"],
  ["processDelta", "must reuse L4 delta cursors for delta-only processing"],
  ["appendKelEvent", "must reuse L0 KEL as the truth log"]
])
  if (!sync.includes(needle)) fail(`estate_sync.mjs ${why} (no '${needle}')`);

// 3. BDD scenarios
const t = spawnSync(process.execPath, ["--test", "tests/estate/estate.test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[n0] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log("[n0] estate model + delta sync engine: scenarios green, reuse contract holds");
console.log("[n0] GATE GREEN");
process.exit(0);
