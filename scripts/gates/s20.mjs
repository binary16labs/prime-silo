#!/usr/bin/env node
// Gate S20 — what is on a backup drive that is not already on F:.
//
// The comparison's own tests run against real files through the real walker and the hub's real
// routes. Then the S17 gate, because S20 adds routes to the same estate API and tabs to the same
// panel: booting the hub three ways and every panel test must still pass.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" }).status;

if (run(["--test", "tests/estate_compare_test.mjs"]) !== 0) {
  console.error("[s20] FAIL: the comparison's own scenarios");
  process.exit(1);
}
if (run([path.join(ROOT, "scripts", "gates", "s17.mjs")]) !== 0) {
  console.error("[s20] FAIL: the S17 gate, which shares S20's estate API and panel");
  process.exit(1);
}
console.log(
  "[s20] a drive is compared with F: by size, then partial hash, then full hash; only a full match is a copy; private files are counted, never listed; every compare route answers this machine only"
);
console.log("[s20] GATE GREEN");
