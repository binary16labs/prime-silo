#!/usr/bin/env node
// Gate S22 — Benny answers from the catalogue. Runs this contract's tests, then the gates of the
// files S22 shares with earlier work: S21 owns library.mjs, estate_api.mjs and the panel, and B2
// owns mcp/server.js. A green S22 that broke either of those would be a gate reporting success
// about half the surface it touches.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[s22] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("S22 tests", [
  "--test",
  "tests/library_test.mjs",
  "tests/librarian_skill_test.mjs",
  "tests/librarian_mcp_test.mjs"
]);
run("s21 — shared library, estate API and panel", ["scripts/gates/s21.mjs"]);
run("b2 — shared mcp/server.js", ["scripts/gates/b2.mjs"]);

console.log(
  "[s22] the owner's questions are answered from the catalogue, never by reading the drive; " +
    "private paths are counted and never named, judged once in the hub for the panel, the skill " +
    "and outside agents alike; the store is configured, not assumed"
);
console.log("[s22] GATE GREEN");
