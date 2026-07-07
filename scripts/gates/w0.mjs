#!/usr/bin/env node
// Gate W0 — work-contract format + full backlog conversion. Hermetic: repo files only.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (!fs.existsSync(path.join(ROOT, "architecture", "SPEC-work-contracts.md"))) {
  console.error("[w0] FAIL: SPEC-work-contracts.md missing");
  process.exit(1);
}

// 1. Unit scenarios (validator behavior incl. over-budget/vague rejection fixtures)
const t = spawnSync(process.execPath, ["--test", "tests/work-contracts/contracts.test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[w0] GATE FAILED (unit scenarios)");
  process.exit(1);
}

// 2. Full-tree validation with a readable report
const { validateBacklog } = await import(
  new URL("../../server/coordination/work-schema/validate.mjs", import.meta.url)
);
const r = validateBacklog(ROOT);
for (const e of r.errors) console.error(`[w0] ${e}`);
console.log(
  `[w0] ${r.count} contracts validated · board + traceability + plan-deps consistent: ${r.ok}`
);
console.log(`[w0] ${r.ok ? "GATE GREEN" : "GATE FAILED"}`);
process.exit(r.ok ? 0 : 1);
