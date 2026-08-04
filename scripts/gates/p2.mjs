#!/usr/bin/env node
// Gate P2 — authoring and navigation land on one record, and the composite stays refused.
//
// Two scales exist: `pypes model-bench` scores manifest authoring, `run_multi_model` scores agentic
// navigation. Putting them on one record is easy. The hard part — and the part this gate is really
// for — is NOT combining them. A weighted composite invented at design time is an unfrozen rubric
// wearing a number, and once it exists it is the number people quote.
//
// The "existing callers are byte-identical" scenario is checked STRUCTURALLY rather than by
// re-running the tool: the gate proves `runtime/benny/pypes/` is untouched since the merge-base.
// That is a stronger guarantee than comparing one sampled output, and it holds without pydantic,
// which the ambient interpreter lacks.
//
// Contract: delivery/tasks/P2.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME = path.join(ROOT, "runtime");
const fail = (msg) => {
  console.error(`[p2] FAIL: ${msg}`);
  process.exit(1);
};
const git = (...args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
const py = (code) =>
  spawnSync(process.env.PYTHON ?? "python", ["-c", code], { cwd: RUNTIME, encoding: "utf8" });

for (const rel of ["runtime/benny/sdlc/bench_record.py", "runtime/tests/sdlc/test_bench_record.py"]) {
  if (!fs.existsSync(path.join(ROOT, rel))) fail(`required artifact missing: ${rel}`);
}

// 1. R21 — existing callers are unaffected because the code they call is UNTOUCHED.
//    Derived from the merge-base, never `git diff main`: main advances, and a two-dot diff on a
//    branch cut before an intervening merge systematically overstates.
const base = git("merge-base", "main", "HEAD").stdout.trim();
if (!base) fail("could not determine the merge-base against main");
const touched = git("diff", "--name-only", `${base}..HEAD`, "--", "runtime/benny/pypes/")
  .stdout.split(/\r?\n/)
  .filter(Boolean);
if (touched.length)
  fail(
    `runtime/benny/pypes/ was modified (${touched.join(", ")}) — P2 must be additive, and ` +
      "model-bench's existing output must be byte-identical for current callers"
  );

// 2. THE REFUSAL, checked behaviourally on a real record rather than by grepping for the word.
const probe = py(`
import json
from benny.sdlc.bench_record import authoring_block, build_record, navigation_block, validate_record, rank_records
from benny.sdlc.sandbox_runner import SandboxResult

trial = {"model": "m", "status": "OK", "auto_scores": {"has_required_ops": 0.8, "step_count": 6}, "quality_score": 7.5}
rec = build_record("s", authoring=authoring_block(trial),
                   navigation=navigation_block(SandboxResult(model="s", tool_selection_accuracy=0.9, total_cost=0.0)),
                   rubric_hash="h", primary_metric="navigation.tool_selection_accuracy")
ok, errors = validate_record(rec)
missing = [b for b in ("authoring", "navigation") if b not in rec]
poisoned_ok, _ = validate_record({**rec, "composite_score": 0.9})
nested_ok, _ = validate_record({**rec, "authoring": {**rec["authoring"], "weighted_mean": 0.5}})
nav = rec["navigation"]
print(json.dumps({
  "ok": ok, "errors": errors, "missing": missing,
  "scored_on": rec["scored_on"],
  "composite_rejected": not poisoned_ok,
  "nested_composite_rejected": not nested_ok,
  "genuine_zero_kept": nav["total_cost"] == 0.0 and "total_cost" not in nav["unmeasured"],
  "unmeasured_stayed_none": nav["total_tokens"] is None and "total_tokens" in nav["unmeasured"],
}))
`);
if (probe.status !== 0) fail(`the record probe did not run:\n${probe.stderr.trim()}`);
const r = JSON.parse(probe.stdout.trim().split(/\r?\n/).pop());

if (!r.ok) fail(`a freshly built record does not validate: ${r.errors.join("; ")}`);
if (r.missing.length) fail(`record is missing block(s): ${r.missing.join(", ")}`);
if (r.scored_on.length !== 2) fail(`scored_on should name both surfaces, got ${JSON.stringify(r.scored_on)}`);
if (!r.composite_rejected) fail("a record carrying composite_score was ACCEPTED — the refusal is hollow");
if (!r.nested_composite_rejected)
  fail("a composite hidden inside a block was ACCEPTED — the check must apply at every depth");

// 3. P1's guarantee must survive serialisation, in BOTH directions. Testing only one direction is
//    how P6's gate ended up blind to a real zero collapsing into a gap.
if (!r.unmeasured_stayed_none) fail("an unmeasured metric did not survive onto the record as null");
if (!r.genuine_zero_kept)
  fail("a genuine 0.0 was recorded as unmeasured — the converse error, and just as wrong");

// 4. No composite anywhere in the module's own source, as a second and independent line.
const src = fs.readFileSync(path.join(RUNTIME, "benny/sdlc/bench_record.py"), "utf8");
for (const m of src.matchAll(/^\s*(?:block|record)\[["'](\w*(?:composite|weighted|overall)\w*)["']\]/gim))
  fail(`bench_record.py assigns a composite-looking field: ${m[1]}`);

const t = spawnSync(process.env.PYTHON ?? "python", ["-m", "pytest", "tests/sdlc/test_bench_record.py", "-q"], {
  cwd: RUNTIME,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[p2] GATE FAILED (acceptance tests)");
  process.exit(1);
}

// P2 sits on P1 and P6. Regression, not an acceptable cost.
for (const g of ["scripts/gates/p1.py", "scripts/gates/p6.py"]) {
  const rr = spawnSync(process.env.PYTHON ?? "python", [g], { cwd: ROOT, stdio: "inherit" });
  if (rr.status !== 0) fail(`${g} regressed`);
}

console.log(
  "[p2] one record with two blocks; composite refused at top level and nested; pypes/ untouched " +
    "since the merge-base so existing callers are byte-identical; unmeasured and genuine-zero both " +
    "survive serialisation — verified"
);
console.log("[p2] GATE GREEN");
process.exit(0);
