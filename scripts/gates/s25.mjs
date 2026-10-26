#!/usr/bin/env node
// Gate S25 — the librarian's edges: bound the work, and say what the answer means.
//
// This contract adds no capability. It bounds work that was unbounded and labels answers that
// meant two things, so its gate runs what it touched (the shared library and estate API, which S22
// owns and which runs S21, S20 and B2 inside itself) rather than a suite of its own. A green S25
// that had broken the library or the panel would be a gate reporting success about surfaces it
// never looked at — the shape claude-s26-verifier called out twice.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[s25] GATE FAILED (${label})`);
    process.exit(1);
  }
};

run("S25 tests", ["--test", "tests/library_test.mjs"]);
run("s26 — the folder routes and the panel this shares its files with", ["scripts/gates/s26.mjs"]);

console.log(
  "[s25] the hub cannot be handed unbounded work: the paths a check accepts are capped before " +
    "anything is hashed and the answer says so, as the walk cap already did; a find with neither " +
    "a word nor a kind is refused rather than listing the drive; the two totals are labelled where " +
    "each is produced, because one word for two meanings is how a caller comes to add them up; a " +
    "folder the owner's own rules cover is explained rather than answered with a bare zero; and an " +
    "agent's question is audited whether it was answered or refused, but never when the caller has " +
    "already gone"
);
console.log("[s25] GATE GREEN");
