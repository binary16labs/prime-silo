#!/usr/bin/env node
// Gate S3 — nodes push their map, the hub folds one estate map.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_MAP_MAX_AGE_MS } from "../../server/coordination/lib/estate_map_fold.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const f of [
  "server/coordination/lib/estate_map_fold.mjs",
  "scripts/estate_satellite_agent.mjs"
])
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error(`[s3] FAIL: ${f} missing`);
    process.exit(1);
  }

// The satellite agent is the outbound edge, and it must reach the wire through withMap() — which
// judges the payload AND keeps the sessions when the map cannot go. What withMap does is tested;
// this only checks the agent goes through it rather than composing the manifest itself.
const agent = fs.readFileSync(path.join(ROOT, "scripts/estate_satellite_agent.mjs"), "utf8");
if (!/withMap\(/u.test(agent) || /manifest\.map\s*=/u.test(agent)) {
  console.error("[s3] FAIL: the satellite agent does not attach its map through withMap()");
  process.exit(1);
}

// The PRODUCT wiring, not the tests' wiring. The tests build the estate API directly and pass a
// policy, so they cannot see that server/app.js passed none — which is how the quarantine guard
// shipped as dead code (claude-s3-verifier's D2). This assertion is the only thing that looks.
// THE PRODUCT'S OWN EXPRESSION, EVALUATED — not matched. Two earlier versions of this check read
// server/app.js and looked for strings in it; the second was defeated by appending "?? []" to the
// quarantine expression: green gate, hub with an empty policy, which is the inert state the D2
// amendment exists to prevent (claude-s3-verifier-3's F1, its X20 mutation). That was the third
// time in this contract that an assertion claimed more than it checked.
//
// So the options object server/app.js passes to createEstateApi is lifted out and RUN, with the
// identifiers it closes over replaced by stubs. The policy reader's stub returns a sentinel, so the
// gate can see what the product actually does with the reader's answer rather than that it merely
// mentions it. What this does NOT do is boot the server: it proves the expression, not the socket.
// The socket is proven by the tests, which drive the real API, and by S3's real-machine run.
function productEstateOptions({ policy, override }) {
  const src = fs.readFileSync(path.join(ROOT, "server/app.js"), "utf8");
  const open = src.indexOf("createEstateApi({");
  const close = src.indexOf("\n    })", open);
  if (open < 0 || close < 0) throw new Error("server/app.js does not build the estate API");
  const literal = src.slice(open + "createEstateApi(".length, close + "\n    }".length);
  // every free identifier the expression may reach for, stubbed
  const make = new Function(
    "overrides",
    "path",
    "fs",
    "coordDir",
    "coordinationBus",
    "readQuarantinePolicy",
    "resolveRegisterKey",
    "DEFAULT_MAP_MAX_AGE_MS",
    `return ${literal};`
  );
  return make(
    override,
    path,
    fs,
    "/coord",
    null,
    () => policy,
    () => "key",
    DEFAULT_MAP_MAX_AGE_MS
  );
}

// With no policy on disk the reader returns null, and null is what the hub must be given: an empty
// list would be a policy, and a hub with a policy accepts maps.
const noPolicy = productEstateOptions({ policy: null, override: {} });
if (noPolicy.quarantine !== null) {
  console.error(
    `[s3] FAIL: with no policy on disk the product hands the hub ${JSON.stringify(noPolicy.quarantine)}, not null — the hub would be inert`
  );
  process.exit(1);
}
const realPolicy = productEstateOptions({ policy: ["payroll"], override: {} });
if (!Array.isArray(realPolicy.quarantine) || realPolicy.quarantine[0] !== "payroll") {
  console.error("[s3] FAIL: the product does not hand the hub the policy its reader returned");
  process.exit(1);
}
if (noPolicy.mapMaxAgeMs !== DEFAULT_MAP_MAX_AGE_MS) {
  console.error("[s3] FAIL: the product does not pass the staleness threshold");
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
