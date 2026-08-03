#!/usr/bin/env node
// Gate W1 — `work next`: deterministic selector + delivery loop.
// The selector is a pure function of (contracts, ledger state, now); the loop composes it with
// claim-and-skip over B0's wx lease, so the same state always yields the same item while two agents
// never receive the same one. Decisions D1-D4: architecture/SOLUTION-W1-work-next.md section 9.
// Contract: delivery/tasks/W1.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = (msg) => {
  console.error(`[w1] FAIL: ${msg}`);
  process.exit(1);
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

for (const rel of [
  "server/coordination/lib/work_select.mjs",
  "server/coordination/lib/work_loop.mjs",
  "runtime/benny/agentamp/work.py",
  "tests/work-contracts/w1_selector_test.mjs"
]) {
  if (!fs.existsSync(path.join(ROOT, rel))) fail(`required artifact missing: ${rel}`);
}

// D3 — verification is a first-class, VALIDATED ledger event, not a payload convention.
const schema = JSON.parse(read("server/coordination/schema/event.schema.json"));
const types = schema.properties?.type?.enum ?? [];
if (!types.includes("task_verified"))
  fail("event.schema.json enum has no 'task_verified' (D3) — author!=verifier would be advisory");
// ...and additive: every pre-existing type must survive, or stored lines stop validating.
for (const t of [
  "task_created",
  "task_claimed",
  "task_progress",
  "task_done",
  "task_blocked",
  "task_released",
  "knowledge_added"
]) {
  if (!types.includes(t)) fail(`D3 was not additive: event type '${t}' was removed from the enum`);
}

// Surfaces wired, not merely present.
const cli = read("runtime/benny_cli.py");
if (!/add_parser\(\s*["']work["']/.test(cli)) fail("benny_cli.py registers no `work` subcommand");
if (!/args\.cmd == ["']work["']/.test(cli)) fail("benny_cli.py never dispatches `work`");
const mcp = read("mcp/server.js");
for (const tool of ["work_next", "work_verify", "work_done", "work_blocked"]) {
  if (!mcp.includes(tool)) fail(`mcp/server.js does not expose the ${tool} tool`);
}

// The selector must stay pure: no clock, no randomness inside the module (D-hazards, section 4).
const sel = read("server/coordination/lib/work_select.mjs");
if (/Math\.random|Date\.now\(\)/.test(sel.replace(/\/\/.*$/gm, "")))
  fail("work_select.mjs reads the clock or randomness — `now` must be injected (section 4)");

const t = spawnSync(process.execPath, ["--test", "tests/work-contracts/w1_selector_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[w1] GATE FAILED (selector / loop scenarios)");
  process.exit(1);
}

// D3 touches a B0-owned artifact. Regression, not an acceptable cost.
for (const g of ["scripts/gates/b0.mjs", "scripts/gates/b1.mjs", "scripts/gates/b2.mjs"]) {
  if (!fs.existsSync(path.join(ROOT, g))) continue;
  const r = spawnSync(process.execPath, [g], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) fail(`${g} regressed — W1's schema change broke a DONE contract`);
}

console.log(
  "[w1] work next: pure deterministic selector + lease-arbitrated loop + human-signed refusal " +
    "+ board/ledger conflict surfacing + validated task_verified — verified"
);
console.log("[w1] GATE GREEN");
process.exit(0);
