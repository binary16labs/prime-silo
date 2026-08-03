#!/usr/bin/env node
// Gate W2 — sandbox + tool provisioning: the allowlist stops being discipline and becomes machinery.
//
// Claiming an item provisions its declared sandbox; `work verify` refuses a diff that escapes the
// allowlist or exceeds the budget, naming the offender; declared tools are preflighted BEFORE work
// starts so a missing one is an immediate honest `blocked` rather than a failure three steps in.
//
// The checks are pure functions over injected inputs (same discipline as W1's selector) so they can
// be tested without a git repo; only the provisioner itself touches git.
// Contract: delivery/tasks/W2.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = (msg) => {
  console.error(`[w2] FAIL: ${msg}`);
  process.exit(1);
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

for (const rel of [
  "server/coordination/lib/sandbox_provision.mjs",
  "tests/work-contracts/w2_provision_test.mjs"
]) {
  if (!fs.existsSync(path.join(ROOT, rel))) fail(`required artifact missing: ${rel}`);
}

const lib = read("server/coordination/lib/sandbox_provision.mjs");

// The three enforcement checks must exist as named exports — the loop calls them, and a verifier
// must be able to import them directly rather than through a git-shaped integration test.
for (const fn of ["checkAllowlist", "checkBudget", "preflightTools", "provisionSandbox"]) {
  if (!new RegExp(`export (async )?function ${fn}\\b`).test(lib))
    fail(`sandbox_provision.mjs does not export ${fn}()`);
}

// The checks stay pure: a pure check is one a verifier can break deterministically; an impure one
// is not. The file declares its own boundary and this asserts the boundary is real — process calls
// (as opposed to the module-level import) must all sit below the marker.
const MARKER = "=== IMPURE BELOW THIS LINE ===";
if (!lib.includes(MARKER)) fail(`sandbox_provision.mjs must declare its purity boundary: ${MARKER}`);
const pureSlice = lib.slice(0, lib.indexOf(MARKER));
if (/\b(spawnSync|execSync|execFileSync|spawn)\s*\(/.test(pureSlice))
  fail("a process call appears above the purity marker — the allowlist/budget/tool checks must be pure");
if (/\bfs\.\w+\(/.test(pureSlice)) fail("a filesystem call appears above the purity marker");

// Wired into the delivery loop, not merely available.
const loop = read("server/coordination/lib/work_loop.mjs");
if (!/sandbox_provision/.test(loop)) fail("work_loop.mjs does not use the provisioner (W2 unwired)");

const t = spawnSync(process.execPath, ["--test", "tests/work-contracts/w2_provision_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[w2] GATE FAILED (provisioning / enforcement scenarios)");
  process.exit(1);
}

// W2 changes the loop that W1 owns. Regression, not an acceptable cost.
for (const g of ["scripts/gates/w1.mjs", "scripts/gates/b2.mjs"]) {
  if (!fs.existsSync(path.join(ROOT, g))) continue;
  const r = spawnSync(process.execPath, [g], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) fail(`${g} regressed — W2 broke a DONE contract it depends on`);
}

console.log(
  "[w2] provisioning: allowlist enforced by machinery + budget refused with its line count " +
    "+ tools preflighted to an honest blocked + worktree provisioned and cleaned — verified"
);
console.log("[w2] GATE GREEN");
process.exit(0);
