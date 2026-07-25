// Unified execution register (L5 / EP-L) — one queryable JSONL projection folding the four
// existing logs (G0 run-events, EP-T train JSONs, the LONGVIEW ledger, the B0 coordination
// ledger) + KEL lineage into one schema. Backfilled once so cross-machine comparability (R16)
// is immediate. It is a REBUILDABLE projection, not truth (steer 1) — so exec_ids are DETERMINISTIC
// (derived from the source, never random) and records are stably ordered: delete + re-fold is
// byte-identical. JSONL not a DB (SOLUTION §4.4); DuckDB is a measure-first fallback, not here. R12–R16.
import crypto from "node:crypto";
import fs from "node:fs";
import { requireAuthorship } from "./authorship.mjs";

// L6: surface authorship enforcement through the register (R38 tagging half).
export { AUTHORSHIP, validateAuthorship, requireAuthorship } from "./authorship.mjs";

export const REGISTER_SCHEMA_VERSION = "1.0.0";
const detId = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

function record({ exec_id, kind, run_id = null, valid_time, txn_time, hlc, machine, config, metrics, lineage, authorship = null, source_log }) {
  return {
    exec_id, kind, run_id, valid_time, txn_time, hlc, machine,
    config, metrics, lineage: lineage ?? { inputs: [], outputs: [] },
    authorship, source_log, schema_version: REGISTER_SCHEMA_VERSION
  };
}

// --- one mapper per source log; each maps a source execution → one register record ---
export function fromG0Run(run) {
  let tokens_in = 0, tokens_out = 0, wall_ms = 0;
  const outputs = [], inputs = [];
  for (const e of run.events ?? []) {
    if (e.event === "node_finished") { tokens_in += e.tokens_in ?? 0; tokens_out += e.tokens_out ?? 0; wall_ms += e.duration_ms ?? 0; }
    if (e.event === "artifact_produced" && e.content_hash) outputs.push(e.content_hash);
    if (e.event === "artifact_consumed" && e.content_hash) inputs.push(e.content_hash);
  }
  return record({
    exec_id: detId(`g0:${run.run_id}`), kind: run.kind ?? "run", run_id: run.run_id,
    valid_time: run.valid_time, txn_time: run.txn_time, hlc: run.hlc, machine: run.machine,
    config: { model_id: run.model?.id ?? null, model_hash: run.model?.hash ?? null, code_commit: run.code_commit ?? null, hw: run.hw ?? {}, knowledge_watermark: run.knowledge_watermark ?? null, hparams: run.hparams ?? {} },
    metrics: { wall_ms, tokens_in, tokens_out, cost_est: run.cost_est ?? 0, quality: run.quality ?? {} },
    lineage: { inputs, outputs }, authorship: run.authorship ?? null, source_log: "g0"
  });
}

export function fromTrainJson(j) {
  return record({
    exec_id: detId(`train:${j.model_id}:${j.txn_time}`), kind: "train",
    valid_time: j.valid_time, txn_time: j.txn_time, hlc: j.hlc ?? `${j.txn_time}-0000-${j.machine ?? "t480"}`, machine: j.machine ?? "t480",
    config: { model_id: j.model_id ?? null, model_hash: j.model_hash ?? null, code_commit: j.code_commit ?? null, hw: j.hw ?? {}, knowledge_watermark: j.knowledge_watermark ?? null, hparams: j.hparams ?? {} },
    metrics: { wall_ms: j.wall_ms ?? null, tokens_in: null, tokens_out: null, cost_est: j.cost_est ?? 0, quality: { eval_nll: j.agg_nll ?? null, base_nll: j.base_agg_nll ?? null } },
    lineage: { inputs: [], outputs: [] }, authorship: j.authorship ?? null, source_log: "train-json"
  });
}

export function fromLongviewLedger(e) {
  return record({
    exec_id: detId(`longview:${e.phase}:${e.txn_time}`), kind: "synthesis",
    valid_time: e.valid_time, txn_time: e.txn_time, hlc: e.hlc ?? `${e.txn_time}-0000-${e.machine ?? "t480"}`, machine: e.machine ?? "t480",
    config: { model_id: e.model_id ?? null, model_hash: null, code_commit: e.code_commit ?? null, hw: {}, knowledge_watermark: e.knowledge_watermark ?? null, hparams: {} },
    metrics: { wall_ms: e.wall_ms ?? null, tokens_in: null, tokens_out: null, cost_est: e.cost_est ?? 0, quality: { outcome: e.outcome ?? null } },
    lineage: { inputs: [], outputs: [] }, source_log: "longview"
  });
}

export function fromCoordEvent(e) {
  return record({
    exec_id: detId(`coord:${e.id}`), kind: "agent", run_id: e.run_id ?? null,
    valid_time: e.ts, txn_time: e.ts, hlc: `${e.ts}-0000-${e.machine ?? "unknown"}`, machine: e.machine ?? "unknown",
    config: { model_id: null, model_hash: null, code_commit: null, hw: {}, knowledge_watermark: null, hparams: {} },
    metrics: { wall_ms: null, tokens_in: null, tokens_out: null, cost_est: 0, quality: { task_id: e.task_id, event: e.type } },
    lineage: { inputs: [], outputs: [] }, authorship: e.agent === "human" ? "human" : null, source_log: "coordination"
  });
}

// --- fold all four sources into one stably-ordered set (deterministic → rebuildable) ---
export function projectRegister({ g0Runs = [], trainJsons = [], longviewLedger = [], coordEvents = [] } = {}) {
  const recs = [
    ...g0Runs.map(fromG0Run),
    ...trainJsons.map(fromTrainJson),
    ...longviewLedger.map(fromLongviewLedger),
    ...coordEvents.map(fromCoordEvent)
  ];
  recs.sort((a, b) =>
    a.source_log < b.source_log ? -1 : a.source_log > b.source_log ? 1 :
    a.exec_id < b.exec_id ? -1 : a.exec_id > b.exec_id ? 1 : 0
  );
  return recs;
}

// `strict` (L6): reject any record that is not provenance-tagged — used where records must be
// training-eligible (the R38 collapse-guard needs a known origin). Default off keeps backfill of
// historical/coordination sources (authorship unknown) working.
export function buildRegister(registerPath, sources, { strict = false } = {}) {
  const recs = projectRegister(sources);
  if (strict)
    for (const r of recs) {
      const v = requireAuthorship(r);
      if (!v.ok) throw new Error(`register record ${r.exec_id} (${r.source_log}): ${v.reason}`);
    }
  fs.writeFileSync(registerPath, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return recs;
}

export function readRegister(registerPath) {
  return fs.readFileSync(registerPath, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

// --- R16: compare executions of the same kind across machines/models (cost/quality delta) ---
export function compareExecutions(records, { kind, delta = false } = {}) {
  const rows = records.filter((r) => r.kind === kind);
  if (!delta) return rows;
  const [a, b] = rows;
  const q = (r) => r?.metrics?.quality?.judge ?? r?.metrics?.quality?.eval_nll ?? null;
  return {
    a: { machine: a?.machine, model: a?.config?.model_id, cost: a?.metrics?.cost_est, quality: q(a) },
    b: { machine: b?.machine, model: b?.config?.model_id, cost: b?.metrics?.cost_est, quality: q(b) },
    cost_delta: (a?.metrics?.cost_est ?? 0) - (b?.metrics?.cost_est ?? 0),
    quality_delta: (q(a) ?? 0) - (q(b) ?? 0)
  };
}
