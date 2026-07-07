#!/usr/bin/env node
// Gate B0 — coordination ledger spec + validator. Hermetic: temp dirs only, no live services.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = (msg) => {
  console.error(`[b0] FAIL: ${msg}`);
  process.exit(1);
};

// 1. Spec + schemas exist and schemas parse
if (!fs.existsSync(path.join(ROOT, "architecture", "SPEC-coordination-ledger.md")))
  fail("SPEC-coordination-ledger.md missing");
for (const s of ["event", "lease", "knowledge"]) {
  const p = path.join(ROOT, "server", "coordination", "schema", `${s}.schema.json`);
  try {
    JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    fail(`${s}.schema.json: ${e.message}`);
  }
}

// 2. Seed agent registry matches the contract
const { SEED_AGENTS } = await import(
  new URL("../../server/coordination/lib/ledger.mjs", import.meta.url)
);
const expected = ["claude", "antigravity", "opencode", "benny", "human"];
if (JSON.stringify(SEED_AGENTS) !== JSON.stringify(expected))
  fail(`seed agents ${SEED_AGENTS} != ${expected}`);

// 3. All acceptance scenarios green (includes the 20-round 3-process wx race)
const r = spawnSync(process.execPath, ["--test", "tests/coordination/ledger.test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
console.log(`[b0] ${r.status === 0 ? "GATE GREEN" : "GATE FAILED"}`);
process.exit(r.status ?? 1);
