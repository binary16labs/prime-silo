#!/usr/bin/env node
// Gate W0 — work-contract format + full backlog conversion. Hermetic: repo files only.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- the budget reading (S27) --------------------------------------------------------------
// `node scripts/gates/w0.mjs --budget <ID> [--base <ref>]` — what this branch has spent against the
// band the contract declared. Meant to be run WHILE the work is going: three contracts in a row
// overran by 30 to 40 per cent, and a figure that only arrives at the end turns a split into
// paperwork. It reports and refuses nothing; w0 itself already enforces band equals budget.
const budgetFor = async (id, base) => {
  const { readBudget, gatherBudgetRows, generatedOutputs, parseFrontmatter } = await import(
    new URL("../../server/coordination/work-schema/validate.mjs", import.meta.url)
  );
  // a missing id or contract exits 1: that is a usage error, not the reading refusing a budget
  const file = path.join(ROOT, "delivery", "tasks", `${id}.md`);
  if (!fs.existsSync(file)) {
    console.error(`[budget] no contract delivery/tasks/${id}.md`);
    process.exit(1);
  }
  const fm = parseFrontmatter(fs.readFileSync(file, "utf8")) ?? {};
  const git = (...args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  // three-dot from the merge base, as the convention says: what THIS branch added, not what main
  // has moved on to since
  const mb = git("merge-base", "HEAD", "main");
  const ref = base || (mb.status === 0 ? mb.stdout.trim() : "") || "main";
  let rows;
  try {
    rows = gatherBudgetRows({ git, ref, repoRoot: ROOT });
  } catch (e) {
    console.error(`[budget] cannot read the budget: ${e.message}`);
    process.exit(1);
  }

  // a figure the formatter would change is not a figure to argue about
  const prettier = path.join(ROOT, "node_modules", "prettier", "bin", "prettier.cjs");
  const formatterRan = fs.existsSync(prettier);
  const candidates = rows
    .filter((r) => !r.binary)
    .map((r) => r.path)
    .filter((f) => /\.(mjs|js|json|md|css|html)$/u.test(f));
  const unformatted =
    formatterRan && candidates.length
      ? (
          spawnSync(process.execPath, [prettier, "--list-different", ...candidates], {
            cwd: ROOT,
            encoding: "utf8"
          }).stdout ?? ""
        )
          .split(/\r?\n/u)
          .map((s) => s.trim().replaceAll("\\", "/"))
          .filter(Boolean)
      : [];

  const r = readBudget({
    id,
    band: fm.band,
    budget: parseInt(fm.budget, 10) || 0,
    rows,
    unformatted,
    generated: generatedOutputs(ROOT),
    formatterRan
  });
  console.log(`[budget] ${id} (band ${r.band ?? "none declared"}) vs ${ref}`);
  console.log(`[budget] ${r.verdict}`);
  for (const c of r.charged.slice(0, 8)) console.log(`[budget]   counted: ${c.added} in ${c.path}`);
  if (r.charged.length > 8)
    console.log(`[budget]   counted: and ${r.charged.length - 8} more files`);
  for (const e of r.excluded)
    console.log(`[budget]   not counted: ${e.added} in ${e.path} — ${e.why}`);
  process.exit(0);
};

const budgetAt = process.argv.indexOf("--budget");
if (budgetAt >= 0) {
  const baseAt = process.argv.indexOf("--base");
  await budgetFor(process.argv[budgetAt + 1], baseAt >= 0 ? process.argv[baseAt + 1] : "");
}

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
