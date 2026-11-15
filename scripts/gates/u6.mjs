#!/usr/bin/env node
// Gate U6 — what is only outside F:, from the catalogues alone.
// U6's tests and the panel, then the U12 gate (u1, u0, s23 and everything inside it).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[u6] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("U6 tests", ["--test", "tests/estate_sole_test.mjs", "tests/estate_map_panel_test.mjs"]);
run("u12 — the routes and catalogue U6 reads", ["scripts/gates/u12.mjs"]);

console.log("[u6] each source says, from the catalogues alone, what is not on F: (by content), what is, and what cannot be told");
console.log("[u6] GATE GREEN");
