#!/usr/bin/env node
// Gate S17 — the map gets a producer.
//
// S17's booted scenarios run INSIDE the s3 gate's worlds (owner-signed amendment, 2026-10-03): the
// production hub reads its policy only from the real coordination directory, and s3 already writes
// it safely in all three shapes, so a second copy of that guard here would be a second place for it
// to go wrong. This gate runs s3 — which also runs tests/estate_map_producer_test.mjs — and the
// panel gate, whose tests now press Sweep.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const gate of ["s3", "s4"]) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "gates", `${gate}.mjs`)], {
    cwd: ROOT,
    stdio: "inherit"
  });
  if (r.status !== 0) {
    console.error(`[s17] FAIL: the ${gate} gate failed, and S17's scenarios run inside it`);
    process.exit(1);
  }
}

console.log(
  "[s17] Sweep reaches the map through the satellites' acceptance, starts only under a policy and only from this machine, one at a time, and stale means unheard"
);
console.log("[s17] GATE GREEN");
