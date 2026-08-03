#!/usr/bin/env node
// Gate P0 — model rosters are declarative and fail closed.
//
// A benchmark SUBJECT is a persona→model assignment plus serving topology, not a model — so a
// heterogeneous roster (one model reviewing, another implementing) ranks as one unit and the
// incumbent is just another subject. Adding a model must be a manifest edit, never code.
//
// The validator is PURE (same discipline as W1's selector and W2's checks): a verifier can break
// every rule deterministically without touching a filesystem.
// Contract: delivery/tasks/P0.md · Design: architecture/SOLUTION-model-plurality.md §4.1, §5.1
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = (msg) => {
  console.error(`[p0] FAIL: ${msg}`);
  process.exit(1);
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

for (const rel of [
  "server/coordination/lib/roster.mjs",
  "runtime/manifests/templates/model_roster.json",
  "tests/roster/roster_test.mjs"
]) {
  if (!fs.existsSync(path.join(ROOT, rel))) fail(`required artifact missing: ${rel}`);
}

const lib = read("server/coordination/lib/roster.mjs");
for (const fn of ["validateRoster", "rubricHash", "resolveSubject"]) {
  if (!new RegExp(`export function ${fn}\\b`).test(lib)) fail(`roster.mjs does not export ${fn}()`);
}

// Pure: a rule you cannot break deterministically is a rule nobody can trust.
if (/spawnSync|execSync|child_process|\bfs\.\w+\(/.test(lib))
  fail("roster.mjs must be pure — no process or filesystem calls in the validator");

// The shipped template must actually satisfy the validator it ships beside. A template that fails
// its own rules is worse than no template: it teaches the wrong shape.
const { validateRoster } = await import(
  new URL("../../server/coordination/lib/roster.mjs", import.meta.url)
);
const template = JSON.parse(read("runtime/manifests/templates/model_roster.json"));
const v = validateRoster(template);
if (!v.ok) fail(`the shipped roster template does not validate: ${v.errors.join("; ")}`);

const t = spawnSync(process.execPath, ["--test", "tests/roster/roster_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[p0] GATE FAILED (roster validation scenarios)");
  process.exit(1);
}

console.log(
  "[p0] rosters: tier eligibility enforced + self-judging refused + unknown labels rejected " +
    "+ rubric frozen by hash + the shipped template validates — verified"
);
console.log("[p0] GATE GREEN");
process.exit(0);
