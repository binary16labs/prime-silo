// L5 acceptance — unified execution register. Scenarios ↔ delivery/tasks/L5.md gherkin.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  projectRegister,
  buildRegister,
  readRegister,
  compareExecutions
} from "../../server/coordination/lib/exec_register.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
const REQUIRED = ["exec_id", "kind", "valid_time", "txn_time", "hlc", "machine", "config", "metrics", "lineage", "source_log", "schema_version"];

// one fixture per source log
function sources() {
  return {
    g0Runs: [{
      run_id: "run_1", machine: "t480", kind: "offload", valid_time: "2026-07-20T10:00:00Z",
      txn_time: "2026-07-20T10:05:00Z", hlc: "2026-07-20T10:05:00.000Z-0000-t480",
      model: { id: "house/qwen2.5-coder-tuned", hash: "sha256:aaa" }, code_commit: "abc123",
      hw: { gpu: "gfx1200", vram_gib: 15.92 }, knowledge_watermark: "sha256:kw1", hparams: {},
      events: [{ event: "node_finished", duration_ms: 1900, tokens_in: 500, tokens_out: 200 },
               { event: "artifact_produced", content_hash: "sha256:out1" }],
      quality: { judge: 1.0, gate_pass: true }, cost_est: 0.0, authorship: "house"
    }],
    trainJsons: [{
      model_id: "house/qwen2.5-coder-tuned", machine: "t480", valid_time: "2026-07-24T00:00:00Z",
      txn_time: "2026-07-24T02:00:00Z", agg_nll: 1.1253, base_agg_nll: 2.6195, code_commit: "abc123"
    }],
    longviewLedger: [{
      phase: "graph", machine: "t480", valid_time: "2026-07-19T00:00:00Z", txn_time: "2026-07-19T00:10:00Z",
      wall_ms: 6000, outcome: "ok"
    }],
    coordEvents: [{
      id: "01J", type: "task_done", agent: "claude", task_id: "L0", ts: "2026-07-25T09:00:00Z", machine: "t480"
    }]
  };
}

test("Scenario: four logs fold into one schema", () => {
  const recs = projectRegister(sources());
  assert.equal(recs.length, 4); // one execution record per source execution
  const bySource = new Set(recs.map((r) => r.source_log));
  assert.deepEqual([...bySource].sort(), ["coordination", "g0", "longview", "train-json"]);
  for (const r of recs) for (const f of REQUIRED) assert.ok(f in r, `record missing ${f} (source ${r.source_log})`);
  // the G0 record carries aggregated metrics + lineage
  const g0 = recs.find((r) => r.source_log === "g0");
  assert.equal(g0.metrics.tokens_out, 200);
  assert.deepEqual(g0.lineage.outputs, ["sha256:out1"]);
});

test("Scenario: cross-machine comparison answers the R16 question", () => {
  const s = sources();
  // same kind (offload) on machine X and Y with different models + cost/quality
  s.g0Runs = [
    { ...s.g0Runs[0], run_id: "rX", machine: "X", model: { id: "A", hash: "h" }, cost_est: 0.02, quality: { judge: 0.9 } },
    { ...s.g0Runs[0], run_id: "rY", machine: "Y", model: { id: "B", hash: "h" }, cost_est: 0.00, quality: { judge: 1.0 } }
  ];
  const recs = projectRegister(s);
  const cmp = compareExecutions(recs, { kind: "offload" });
  assert.equal(cmp.length, 2);
  const delta = compareExecutions(recs, { kind: "offload", delta: true });
  assert.equal(delta.cost_delta, 0.02); // A costs 0.02 more than B
  assert.equal(Math.round(delta.quality_delta * 100) / 100, -0.1); // A judge 0.1 lower
});

test("Scenario: the register is a rebuildable projection (delete + re-fold identical)", () => {
  const dir = tmp();
  const p = path.join(dir, "executions.jsonl");
  const first = fs.readFileSync(buildRegister(p, sources()) && p, "utf8");
  fs.unlinkSync(p);
  const second = fs.readFileSync(buildRegister(p, sources()) && p, "utf8");
  assert.equal(second, first); // byte-for-byte identical — no random ids, stable order
});

test("backfill is deterministic and readable", () => {
  const a = JSON.stringify(projectRegister(sources()));
  const b = JSON.stringify(projectRegister(sources()));
  assert.equal(a, b);
  const dir = tmp();
  const p = path.join(dir, "executions.jsonl");
  buildRegister(p, sources());
  assert.equal(readRegister(p).length, 4);
});
