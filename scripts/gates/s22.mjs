#!/usr/bin/env node
// Gate S22 — Benny answers from the catalogue. Runs this contract's tests, then the gates of the
// files S22 shares with earlier work: S21 owns library.mjs, estate_api.mjs and the panel, and B2
// owns mcp/server.js. A green S22 that broke either of those would be a gate reporting success
// about half the surface it touches.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

// The boot test skips when the MCP SDK is absent, which is right for a fresh clone - but this gate
// then printed its whole success sentence, outside agents included, about a Scenario that did not
// run (claude-s22-verifier-3). Say so instead of claiming it.
const bootable = fs.existsSync(path.join(ROOT, "mcp", "node_modules", "@modelcontextprotocol"));

run("S22 tests", [
  "--test",
  "tests/library_test.mjs",
  "tests/librarian_skill_test.mjs",
  "tests/librarian_mcp_test.mjs",
  // boots the shipped mcp/server.js for real and speaks JSON-RPC to it; skips with the command to
  // fix it when the SDK is not installed, so a fresh clone does not fail the gate
  "tests/librarian_mcp_boot_test.mjs"
]);
run("s21 — shared library, estate API and panel", ["scripts/gates/s21.mjs"]);
run("b2 — shared mcp/server.js", ["scripts/gates/b2.mjs"]);

if (!bootable)
  console.log(
    "[s22] NOT TESTED: the MCP tools were not booted, so nothing here exercised outside agents. " +
      "Run `npm ci --prefix mcp` and this gate again before trusting that half."
  );
console.log(
  "[s22] the owner's questions are answered from the catalogue, never by reading the drive; " +
    "private paths are counted and never named, judged once in the hub for the panel " +
    (bootable ? "and the in-app skill and outside agents alike" : "and the in-app skill") +
    "; the store is configured, not assumed"
);
console.log("[s22] GATE GREEN");
