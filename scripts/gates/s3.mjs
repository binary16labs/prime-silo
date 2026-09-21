#!/usr/bin/env node
// Gate S3 — nodes push their map, the hub folds one estate map.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const f of [
  "server/coordination/lib/estate_map_fold.mjs",
  "scripts/estate_satellite_agent.mjs"
])
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error(`[s3] FAIL: ${f} missing`);
    process.exit(1);
  }

// The satellite agent is the outbound edge. It must import the guard and assert it before sending:
// a map that cannot be judged here is a map that travels unjudged.
const agent = fs.readFileSync(path.join(ROOT, "scripts/estate_satellite_agent.mjs"), "utf8");
if (!/mapPayloadProblem/u.test(agent)) {
  console.error("[s3] FAIL: the satellite agent does not judge its map payload before sending");
  process.exit(1);
}

// The PRODUCT wiring, not the tests' wiring. The tests build the estate API directly and pass a
// policy, so they cannot see that server/app.js passed none — which is how the quarantine guard
// shipped as dead code (claude-s3-verifier's D2). This assertion is the only thing that looks.
const appJs = fs.readFileSync(path.join(ROOT, "server/app.js"), "utf8");
const wiring = appJs.slice(appJs.indexOf("createEstateApi({"));
for (const option of ["quarantine:", "mapMaxAgeMs:"])
  if (!wiring.slice(0, wiring.indexOf("})")).includes(option)) {
    console.error(`[s3] FAIL: server/app.js builds the estate API without ${option}`);
    process.exit(1);
  }

const t = spawnSync(process.execPath, ["--test", "tests/estate_map_fold_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[s3] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[s3] the node pushes and the hub folds; a quiet node is stale, not empty; only counts and hashes cross"
);
console.log("[s3] GATE GREEN");
process.exit(0);
