#!/usr/bin/env node
// Gate U7 — the copy plan: what goes onto F:, where, and whether it fits; raised, never signed.
// U7 tests and the panel, then the U6 gate (u12, u1, u0, s23 and everything inside it).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[u7] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("U7 tests", ["--test", "tests/estate_plan_copy_test.mjs", "tests/estate_map_panel_test.mjs"]);
run("u6 — the sole content U7 plans from", ["scripts/gates/u6.mjs"]);

console.log("[u7] each source gets a plan from the catalogues: F:-held content never proposed, repeats once, exclusions and cloud-only said, names never overwritten, raised for the owner and never signed here");
console.log("[u7] GATE GREEN");
