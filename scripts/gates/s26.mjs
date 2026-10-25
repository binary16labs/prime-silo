#!/usr/bin/env node
// Gate S26 — Drives: walk the estate from the catalogue, not the disk.
//
// Runs this contract's tests, then the gates of what it shares: S22 owns library.mjs and
// estate_api.mjs (and runs S21 and B2 inside itself), and C0 governs any CSS this adds. A green
// S26 that broke the library or shipped a hex literal would be a gate reporting success about
// surfaces it never looked at.
//
// It also re-derives the two registries, because a surface nobody zoned and a screen no use case
// opens are exactly what those files exist to reveal — and both were red before this contract.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[s26] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("S26 tests", ["--test", "tests/library_test.mjs", "tests/drives_panel_test.mjs"]);
run("c0 — the design contract, for the panel's CSS", ["scripts/gates/c0.mjs"]);
run("sitemap — every surface zoned", ["scripts/sitemap_build.mjs"]);
run("use cases — every surface exercised", ["scripts/usecases_build.mjs"]);
run("s22 — shared library, estate API, skill and MCP tools", ["scripts/gates/s22.mjs"]);

console.log(
  "[s26] every folder knows its own weight and how much of it exists somewhere else; the two are " +
    "never merged, because one says retire the tree and the other says de-duplicate inside it; the " +
    "rollup is built by the worker and never on the request thread; private paths are counted and " +
    "never named, folder names included; and nothing here reads a drive, so it answers unplugged"
);
console.log("[s26] GATE GREEN");
