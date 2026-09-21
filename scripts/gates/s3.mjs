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
// bounded by the call's own closing line, not by the first "})" — the options are multi-line
const from = appJs.indexOf("createEstateApi({");
const wiring = appJs.slice(from, appJs.indexOf("\n    })", from));
for (const option of ["quarantine:", "mapMaxAgeMs:"])
  if (!wiring.includes(option)) {
    console.error(`[s3] FAIL: server/app.js builds the estate API without ${option}`);
    process.exit(1);
  }
// The reader itself lives in the library with its io injected, so its warning is tested there;
// what the gate checks here is that the product calls it at all.

// and that the value it passes is the POLICY READER, not some other thing that happens to be an
// array — `quarantine: [] || readQuarantinePolicy(…)` passes the check above and is a hub with an
// empty policy, which is the inert state D2 was about. This is a textual check because booting the
// whole server inside a unit gate is not proportionate; the reader's own behaviour is tested.
if (!/quarantine:\s*overrides\.\w+\s*\?\?\s*readQuarantinePolicy\(/su.test(wiring)) {
  console.error("[s3] FAIL: server/app.js does not pass its quarantine policy from the reader");
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
