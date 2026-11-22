// Stage gate: a LONGVIEW phase is judged by what it produced, not by its exit
// code alone. Replays the three C0 (2026-11-21) false ✓s, then the contract
// edges, then the one-python resolver.
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { checkPhase, PHASES_WITH_CONTRACTS } from "../scripts/longview/lib/phase_gate.mjs";
import { runtimePython, runtimeEnv, checkRuntimePython } from "../scripts/longview/lib/runtime_py.mjs";
import { repairMarkdown, mermaidBlocks, fallbackDiagrams } from "../scripts/longview/lib/md_fences.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = Date.parse("2026-11-22T00:00:00Z");
const at = (mins) => new Date(T0 + mins * 60000).toISOString();
const fresh = { size: 5_000_000, mtimeMs: T0 + 30 * 60000 };
const stale = { size: 5_000_000, mtimeMs: T0 - 3600000 };
const paths = { sadMd: "S.md", sadPdf: "S.pdf", bookMd: "B.md", bookPdf: "B.pdf" };
const statFrom = (m) => (p) => m[p] ?? null;
const run = (id, ledger, files = {}, exitOk = true) =>
  checkPhase(id, { exitOk, startedMs: T0, ledger, stat: statFrom(files), paths });

// ── 1. The C0 replays: each exited 0 and printed ✓. Each must now FAIL. ──
const pyErr = "ModuleNotFoundError: No module named 'pydantic'";
let g = run("code", [{ ts: at(1), phase: "code", ok: false, tail: pyErr }]);
assert.equal(g.verdict, "fail", "C0 code: exit 0 + ledger ok:false must fail");
assert.match(g.problem, /pydantic/, "the failure names the real cause");
g = run("enrich", [{ ts: at(1), phase: "enrich", ok: false, tail: pyErr }]);
assert.equal(g.verdict, "fail", "C0 enrich");
g = run(
  "sad",
  [
    { ts: at(1), phase: "sad", artifact: "code_scan", ok: true, exit: 0 },
    { ts: at(150), phase: "sad", flow: "togaf_epic_v7", exit: 1, error: null }
  ],
  { "S.md": fresh, "S.pdf": fresh }
);
assert.equal(g.verdict, "fail", "C0 sad: PDF diagram gate exit 1 must fail even with files present");
assert.match(g.problem, /exit 1/);

// ── 2. Silence is not success. ──
g = run("code", []);
assert.equal(g.verdict, "fail", "no ledger result = the phase never said what happened");
assert.match(g.problem, /no result/);
g = run("code", [{ ts: at(-90), phase: "code", ok: true }]);
assert.equal(g.verdict, "fail", "a PREVIOUS run's ok must not pass this run");
g = run("code", [{ ts: at(-90), phase: "code", ok: false }, { ts: at(2), phase: "code", ok: true }]);
assert.equal(g.verdict, "pass", "this run's ok passes");
assert.equal(g.contract, "outputs");

// ── 3. SAD contract. ──
const sadOk = [{ ts: at(100), phase: "sad", flow: "togaf_epic_v7", exit: 0 }];
assert.equal(run("sad", sadOk, { "S.md": fresh, "S.pdf": fresh }).verdict, "pass");
g = run("sad", sadOk, { "S.md": fresh, "S.pdf": stale });
assert.equal(g.verdict, "fail", "a PDF left over from an earlier run is stale");
assert.match(g.problem, /stale/);
g = run("sad", sadOk, { "S.md": fresh, "S.pdf": { size: 0, mtimeMs: fresh.mtimeMs } });
assert.equal(g.verdict, "fail", "an empty PDF fails");
g = run("sad", sadOk, { "S.md": fresh });
assert.equal(g.verdict, "fail", "a missing PDF fails");
g = run("sad", [...sadOk, { ts: at(1), phase: "sad", artifact: "code_scan", ok: false, exit: 2 }], {
  "S.md": fresh,
  "S.pdf": fresh
});
assert.equal(g.verdict, "warn", "a failed code-graph refresh is recorded, not fatal");
assert.match(g.warnings.join(), /code graph refresh/);

// ── 4. Book (opus): crashes fail; kept-best-draft is a recorded warning. ──
const cov = (o = {}) => ({ ts: at(170), phase: "opus", artifact: "coverage", sections_missing: 0, citation_coverage: 0.5, ok: true, ...o });
const sec = (id, o = {}) => ({ ts: at(5), phase: "opus", artifact: `section:${id}`, ok: true, ...o });
assert.equal(run("opus", [sec("a"), sec("b"), cov()], { "B.md": fresh }).verdict, "pass");
g = run("opus", [sec("a"), sec("b", { ok: false, gate_errors: ["cites<6"] }), cov()], { "B.md": fresh });
assert.equal(g.verdict, "warn", "gate-failed sections never stop the run (thresholds are Y2's, signed)");
assert.deepEqual(g.checks.find((c) => c.check === "section quality gate").sections, ["b"]);
g = run("opus", [sec("a"), sec("b", { ok: false, error: "LLM deadline" }), cov()], { "B.md": fresh });
assert.equal(g.verdict, "fail", "a crashed section fails");
g = run("opus", [sec("a")], { "B.md": fresh });
assert.equal(g.verdict, "fail", "no coverage record = not assembled");
g = run("opus", [sec("a"), cov({ sections_missing: 3 })], { "B.md": fresh });
assert.equal(g.verdict, "fail", "missing sections fail");
g = run("opus", [sec("a"), cov({ ok: false, citation_coverage: 0.2 })], { "B.md": fresh });
assert.equal(g.verdict, "warn", "coverage below threshold is recorded");
g = run("opus", [sec("a"), cov()], {});
assert.equal(g.verdict, "fail", "no book markdown fails");

// ── 5. Book PDF. ──
assert.equal(run("pdf", [{ ts: at(1), phase: "pdf", ok: true, bytes: 9e6 }], { "B.pdf": fresh }).verdict, "pass");
assert.equal(run("pdf", [{ ts: at(1), phase: "pdf", ok: false, error: "no assembled book" }]).verdict, "fail");
assert.equal(run("pdf", [{ ts: at(1), phase: "pdf", ok: true }], {}).verdict, "fail", "ok:true but no file");

// ── 6. Any phase: a recorded phase_error fails; exit code still counts. ──
g = run("map", [{ ts: at(3), phase: "map", action: "phase_error", error: "boom" }]);
assert.equal(g.verdict, "fail");
assert.equal(run("map", []).verdict, "pass", "no contract → exit code decides");
assert.equal(run("map", []).contract, "exit-code only");
assert.equal(run("map", [], {}, false).verdict, "fail");
assert.equal(run("sad", sadOk, { "S.md": fresh, "S.pdf": fresh }, false).verdict, "fail", "non-zero exit always fails");
for (const id of ["code", "enrich", "sad", "opus", "pdf"]) assert.ok(PHASES_WITH_CONTRACTS.includes(id), id);

// ── 7. One python: override → bundle → PATH (flagged). ──
const W = { APPDATA: "C:\\A" };
assert.equal(runtimePython({ env: { ...W, PRIME_SILO_RUNTIME_PY: "X:\\py.exe" } }).source, "PRIME_SILO_RUNTIME_PY");
let rp = runtimePython({ env: W, exists: () => true });
assert.equal(rp.source, "runtime-bundle");
assert.ok(rp.py.includes("runtime-bundle"));
rp = runtimePython({ env: W, exists: () => false });
assert.equal(rp.py, "python");
assert.match(rp.source, /PATH/);
const e = runtimeEnv("R", runtimePython({ env: W, exists: () => true }), { PYTHONPATH: "old" });
assert.ok(e.PYTHONPATH.startsWith("R" + path.delimiter), "runtime dir first");
assert.ok(e.PYTHONPATH.includes("site") && e.PYTHONPATH.endsWith("old"));
assert.equal(e.PYTHONUTF8, "1");

// preflight: the C0 failure is caught before any phase runs
const bad = checkRuntimePython("R", {
  env: W,
  spawn: () => ({ status: 1, stderr: `Traceback...\n${pyErr}\n` })
});
assert.equal(bad.ok, false);
assert.equal(bad.error, pyErr);
assert.equal(checkRuntimePython("R", { env: W, spawn: () => ({ status: 0, stderr: "" }) }).ok, true);

// ── 8. Source guards: no phase spawns the bare PATH python again, and every
//       benny-backed phase reports its failure through the exit code. ──
const src = fs.readFileSync(path.join(REPO, "scripts/longview/longview.mjs"), "utf8");
assert.doesNotMatch(src, /spawn(Sync)?\(\s*"python"/, "bare PATH python is back in longview.mjs");
// one per failure path: code (junction, python), enrich (python), pdf (no book,
// print), sad (flow missing, flow failed)
const FAIL_PATHS = { runCode: 2, runEnrichGraph: 1, runPdfPhase: 2, runSad: 2, runSadPdf: 2 };
for (const [fn, n] of Object.entries(FAIL_PATHS)) {
  const start = src.indexOf(`function ${fn}(`);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  const got = (body.match(/process\.exitCode = 1/g) || []).length;
  assert.equal(got, n, `${fn}: every failure path must set a failing exit code (${got}/${n})`);
}

// ── 9. Fence repair (the C0 SAD's three defects, in miniature). ──
const F = "```";
const doc = [
  "# A", "", `${F}markdown`, "## wrapped section", "prose", `${F}`, "",
  `${F}mermaid`, "flowchart LR", "  a --> b", `${F}`,
  "References: [EV-1]", `${F}`, "",                       // stray closer
  "**Diagram**", "", `${F}mermaid`, "flowchart LR", "  c --> d", `${F}`,
  `${F}mermaid`, "classDiagram-diagnostics", "  class x", `${F}`,
  `${F}js`, "let a = 1;", `${F}`
].join("\n");
const naive = (md) => { // the HTML renderer's rule: any fence closes
  let mode = null, n = 0;
  for (const l of md.split("\n")) { const t = l.trim(), f = /^```(\w*)/.exec(t);
    if (mode) { if (t.startsWith("```")) mode = null; continue; }
    if (f) { mode = f[1] || "c"; if (f[1] === "mermaid") n++; } }
  return n;
};
assert.notEqual(naive(doc), 3, "fixture reproduces the parity flip");
const rep = repairMarkdown(doc);
const kinds = rep.fixes.map((f) => f.kind).sort();
assert.deepEqual(kinds, ["mermaid_type", "orphan_fence", "unwrapped_prose"]);
assert.equal(naive(rep.md), 3, "after repair the renderer sees every diagram");
assert.equal(mermaidBlocks(rep.md), 3);
assert.match(rep.md, /^## wrapped section$/m, "wrapped prose is prose again");
assert.match(rep.md, /^classDiagram$/m);
assert.match(rep.md, /```js\nlet a = 1;\n```/, "ordinary code blocks untouched");
assert.equal(repairMarkdown(rep.md).fixes.length, 0, "idempotent");
assert.equal(repairMarkdown("x\n```mermaid\nflowchart LR\n").fixes[0].kind, "unclosed_block");
assert.equal(repairMarkdown("ok\n```\ncode\n```\n").fixes.length, 0, "a balanced bare block is not an orphan");
const fb = fallbackDiagrams(rep.md, [2]);
assert.equal(mermaidBlocks(fb), 2, "fallback removes exactly the named diagram");
assert.match(fb, /⚠ Diagram could not be rendered[\s\S]*```text\nclassDiagram/);

// SAD gate: a repair that made the PDF pass is a recorded warning, not silence.
g = run(
  "sad",
  [
    { ts: at(100), phase: "sad", artifact: "md_repair", ok: true, fixes: { orphan_fence: 1 }, fallback: [189] },
    { ts: at(101), phase: "sad", flow: "togaf_epic_v7", exit: 0, v7_exit: 1 }
  ],
  { "S.md": fresh, "S.pdf": fresh }
);
assert.equal(g.verdict, "warn");
assert.match(g.warnings.join(), /1 orphan_fence/);
assert.match(g.warnings.join(), /#189/);

console.log("longview_stage_gate_test: all assertions passed");
