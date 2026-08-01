// Execution Contract Register — the single canonical answer to "which workflow,
// of which type, ran which processes, producing what outputs, under which contract".
//
// WHY THIS EXISTS. Execution evidence was scattered across five stores, so no view
// could answer that question end to end:
//   1. runtime/workspace/governance.log  — TASK_METADATA_UPDATE, NODE_EXECUTION_STATE,
//      LINEAGE_{START,COMPLETE}_WORKFLOW, LINEAGE_TOOL_EXECUTION, ENRICH_TASK_FAILED
//   2. <ws>/runs/<run>/manifest.json     — the CONTRACT that governed the run
//   3. <ws>/runs/<run>/task_*.json       — per-process outcome, elapsed, error, _sha256
//   4. <ws>/longview/lineage/openlineage*.json — OpenLineage RunEvents (two files)
//   5. runtime/manifests/templates/*.json      — the contract catalog
// This module folds all five into ONE register keyed by execution, each execution
// bound to its contract and carrying its process DAG, datasets and integrity facts.
//
// It is deterministic and read-only: it derives, it never mutates. Consumers are the
// v7 SAD generator (lineage + object-architecture chapters), the control-plane
// dashboard (execute/monitor/review), and the BCBS-239 / SS1/23 control evidence.

import fs from "fs";
import path from "path";

// --- execution taxonomy: the "which type" the regulator asked for ---------
export const EXEC_TYPES = {
  enrich: "Knowledge enrichment (contract-driven, waved DAG)",
  swarm_workflow: "Swarm/agent workflow (planner-driven DAG)",
  longview_phase: "LONGVIEW synthesis phase (map/reduce pipeline)",
  rag_ingest: "Document ingestion into the knowledge graph + vector index",
  tool: "Single tool execution (child of a parent run)",
  sad_build: "Architecture document generation (TOGAF EPIC)",
  agent_reasoning: "Agent reasoning run",
  unknown: "Unclassified execution"
};

function classify(id, meta = {}) {
  const s = String(id || "").toLowerCase();
  const producer = String(meta.producer || "").toLowerCase();
  if (producer.includes("togaf") || s.startsWith("togaf-epic")) return "sad_build";
  if (s.startsWith("enrich-") || s.includes("enrichment")) return "enrich";
  if (s.startsWith("run-") || meta.type === "swarm_workflow") return "swarm_workflow";
  if (s.includes("rag_ingest") || meta.type === "rag_ingest") return "rag_ingest";
  if (s.includes("agent_reasoning")) return "agent_reasoning";
  if (s.includes("tool.")) return "tool";
  if (["inventory", "extract", "map", "graph", "enrich", "reduce", "opus", "pdf", "sad", "code", "weave", "review"].includes(s))
    return "longview_phase";
  return "unknown";
}

const iso = (v) => (typeof v === "string" ? v : "");
const secsBetween = (a, b) => {
  const t1 = Date.parse(a), t2 = Date.parse(b);
  return Number.isFinite(t1) && Number.isFinite(t2) && t2 >= t1 ? Math.round((t2 - t1) / 100) / 10 : null;
};

function blankExec(id, type) {
  return {
    execution_id: id,
    type: type || "unknown",
    type_label: EXEC_TYPES[type || "unknown"],
    contract_id: null,
    contract_file: null,
    contract_name: null,
    workspace: null,
    status: "unknown",
    started: null,
    ended: null,
    duration_s: null,
    git_commit: null,
    model: null,
    processes: [],          // the DAG actually executed
    inputs: [],
    outputs: [],
    evidence: [],           // on-disk artifacts proving the run
    event_count: 0,
    integrity: { hashed_events: 0, hashed_records: 0 }
  };
}

// -------------------------------------------------------------------------
// 1. Contract catalog — the manifests an execution can be bound to.
// -------------------------------------------------------------------------
export function loadContracts(repoRoot) {
  const dir = path.join(repoRoot, "runtime", "manifests", "templates");
  const contracts = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return contracts; }
  for (const f of files) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    const plan = m.plan && typeof m.plan === "object" ? m.plan : {};
    const rawTasks = plan.tasks || plan.phases || plan.steps || m.steps || m.stages || [];
    const tasks = (Array.isArray(rawTasks) ? rawTasks : [])
      .map((t) => (typeof t === "string" ? { id: t, description: "" }
        : { id: String(t.id || t.name || ""), description: String(t.description || "").slice(0, 240) }))
      .filter((t) => t.id);
    const edges = (plan.edges || []).map((e) =>
      Array.isArray(e) ? [String(e[0]), String(e[1])]
        : [String(e.source || e.from || ""), String(e.target || e.to || "")]).filter((p) => p[0] && p[1]);
    contracts[m.id || f] = {
      id: m.id || f, file: f, name: m.name || f,
      schema_version: m.schema_version || null,
      description: String(m.description || "").slice(0, 600),
      executor: String(m.executor || ""),
      tasks, edges,
      waves: Array.isArray(plan.waves) ? plan.waves : [],
      declared_task_count: tasks.length
    };
  }
  return contracts;
}

// -------------------------------------------------------------------------
// 2. Run records — the strongest binding: a run folder holds its own contract.
// -------------------------------------------------------------------------
function foldRunRecords(execs, bennyHome, workspace, contracts) {
  const runsDir = path.join(bennyHome, "workspaces", workspace, "runs");
  let entries = [];
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
  for (const d of entries) {
    const dir = path.join(runsDir, d.name);
    const ex = execs.get(d.name) || blankExec(d.name, classify(d.name));
    ex.workspace = workspace;
    ex.evidence.push(path.join("runs", d.name));
    // the contract that governed this run
    try {
      const man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
      ex.contract_id = man.id || ex.contract_id;
      ex.contract_name = man.name || ex.contract_name;
      // the field that SHOULD exist at instantiation; honoured when present
      ex.template_id = man.template_id || man.derived_from || man.parent_id || null;
      ex.instantiated_manifest = true;
      const match = Object.values(contracts).find((c) => c.id === man.id || c.name === man.name);
      ex.contract_file = match ? match.file : ex.contract_file;
      ex.evidence.push(path.join("runs", d.name, "manifest.json"));
    } catch { /* not every run folder carries its manifest */ }
    try {
      const sum = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
      ex.status = sum.status || ex.status;
      ex.started = ex.started || iso(sum.started_at || sum.start);
      ex.ended = ex.ended || iso(sum.finished_at || sum.end);
      ex.evidence.push(path.join("runs", d.name, "summary.json"));
    } catch { /* optional */ }
    // per-process records
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.startsWith("task_") && f.endsWith(".json")); } catch { }
    for (const f of files) {
      let t;
      try { t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
      ex.processes.push({
        node_id: t.task_id || f.replace(/^task_|\.json$/g, ""),
        wave: typeof t.wave === "number" ? t.wave : null,
        status: t.status || "unknown",
        started: iso(t.timestamp),
        duration_s: typeof t.elapsed_s === "number" ? t.elapsed_s : null,
        error: t.error ? String(t.error).slice(0, 300) : null,
        lineage_ref: t.lineage_ref || null,
        integrity_sha256: t._sha256 || null,
        source: "run_record"
      });
      if (t._sha256) ex.integrity.hashed_records += 1;
    }
    if (fs.existsSync(path.join(dir, "GDPR_notice.json"))) {
      ex.evidence.push(path.join("runs", d.name, "GDPR_notice.json"));
    }
    execs.set(d.name, ex);
  }
}

// -------------------------------------------------------------------------
// 3. Governance ledger — the process-level truth (streamed; the log is MBs).
// -------------------------------------------------------------------------
function foldLedger(execs, repoRoot, contracts) {
  // The ledger ROTATES at ~5 MB (governance.log -> governance.log.1 -> .2 ...).
  // Reading only the live file silently drops every prior execution: measured
  // 2026-08-01, the current log held 55 lines while governance.log.1 held 5.2 MB
  // of history, collapsing the register from 191 executions to 57. Audit
  // continuity requires ALL segments, oldest first.
  const dir = path.join(repoRoot, "runtime", "workspace");
  let segments = [];
  try {
    segments = fs.readdirSync(dir)
      .filter((f) => f === "governance.log" || /^governance\.log\.\d+$/.test(f))
      .sort((a, b) => {
        const n = (x) => (x === "governance.log" ? 0 : Number(x.split(".").pop()));
        return n(b) - n(a);                      // highest suffix = oldest, read first
      })
      .map((f) => path.join(dir, f));
  } catch { return { lines: 0, segments: 0 }; }
  if (!segments.length) return { lines: 0, segments: 0 };

  const lines = [];
  for (const seg of segments) {
    try { lines.push(...fs.readFileSync(seg, "utf8").split("\n")); } catch { /* skip */ }
  }
  let used = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    const ws = e.workspace || d.workspace || null;
    const hashed = e._integrity_hash ? 1 : 0;
    const touch = (id, type) => {
      if (!id) return null;
      const ex = execs.get(id) || blankExec(id, type);
      ex.event_count += 1;
      ex.integrity.hashed_events += hashed;
      if (ws && !ex.workspace) ex.workspace = ws;
      const ts = iso(e.timestamp);
      if (ts && (!ex.started || ts < ex.started)) ex.started = ts;
      if (ts && (!ex.ended || ts > ex.ended)) ex.ended = ts;
      execs.set(id, ex);
      return ex;
    };

    switch (e.event_type) {
      case "TASK_METADATA_UPDATE": {
        const ex = touch(d.task_id, classify(d.task_id, { ...d, producer: (d.metadata || {}).producer }));
        if (!ex) break;
        used++;
        if (d.status) ex.status = d.status;
        if ((d.metadata || {}).producer) ex.producer = d.metadata.producer;
        if (d.type && ex.type === "unknown") { ex.type = d.type; ex.type_label = EXEC_TYPES[d.type] || d.type; }
        // AER steps are the executed processes for swarm/SAD runs
        for (const s of d.aer_log || []) {
          const m = /Executing task: (\S+)/.exec(s.intent || "");
          if (!m) continue;
          if (!ex.processes.some((p) => p.node_id === m[1] && p.source === "aer")) {
            ex.processes.push({
              node_id: m[1], wave: null, status: "completed",
              started: iso(s.timestamp), duration_s: null, error: null,
              lineage_ref: null, integrity_sha256: null, source: "aer"
            });
          }
        }
        break;
      }
      case "NODE_EXECUTION_STATE": {
        const ex = touch(d.execution_id, classify(d.execution_id));
        if (!ex) break;
        used++;
        const existing = ex.processes.find((p) => p.node_id === d.node_id && p.source === "node_state");
        const rec = existing || {
          node_id: d.node_id, wave: null, status: d.status, started: iso(d.timestamp),
          duration_s: null, error: null, lineage_ref: null, integrity_sha256: null, source: "node_state"
        };
        rec.status = d.status || rec.status;
        if (typeof d.duration_ms === "number" && d.duration_ms > 0) rec.duration_s = Math.round(d.duration_ms) / 1000;
        if (d.error) rec.error = String(d.error).slice(0, 300);
        if (d.inputs && Object.keys(d.inputs).length) rec.inputs = d.inputs;
        if (d.outputs && Object.keys(d.outputs).length) rec.outputs = d.outputs;
        if (!existing) ex.processes.push(rec);
        break;
      }
      case "ENRICH_TASK_FAILED": {
        const id = d.lineage_ref || d.run_id;
        const ex = touch(id, "enrich");
        if (!ex) break;
        used++;
        ex.status = "failed";
        const rec = ex.processes.find((p) => p.node_id === d.task_id);
        if (rec) { rec.status = "failed"; rec.error = String(d.error || "").slice(0, 300); }
        else ex.processes.push({
          node_id: d.task_id, wave: d.wave ?? null, status: "failed", started: iso(d.timestamp),
          duration_s: d.elapsed_s ?? null, error: String(d.error || "").slice(0, 300),
          lineage_ref: d.lineage_ref || null, integrity_sha256: d._sha256 || null, source: "ledger"
        });
        if (d._sha256) ex.integrity.hashed_records += 1;
        break;
      }
      case "LINEAGE_START_WORKFLOW":
      case "LINEAGE_COMPLETE_WORKFLOW":
      case "LINEAGE_TOOL_EXECUTION": {
        const run = d.run || {};
        const job = d.job || {};
        const id = run.runId;
        const isTool = e.event_type === "LINEAGE_TOOL_EXECUTION";
        const ex = touch(id, isTool ? "tool" : classify(job.name || id, d));
        if (!ex) break;
        used++;
        if (job.name && !ex.contract_name) ex.contract_name = job.name;
        const et = String(d.eventType || "").toUpperCase();
        if (et === "COMPLETE") ex.status = "completed";
        else if (et === "FAIL") ex.status = "failed";
        else if (et === "START" && ex.status === "unknown") ex.status = "running";
        for (const f of Object.values(run.facets || {})) {
          if (f && typeof f === "object") {
            if (f.git_commit) ex.git_commit = f.git_commit;
            if (f.model) ex.model = f.model;
            if (f.run && f.run.runId) ex.parent_run = f.run.runId;   // parent facet
          }
        }
        for (const i of d.inputs || []) if (i && i.name && !ex.inputs.includes(i.name)) ex.inputs.push(i.name);
        for (const o of d.outputs || []) if (o && o.name && !ex.outputs.includes(o.name)) ex.outputs.push(o.name);
        break;
      }
      default:
        break;
    }
  }
  return { lines: lines.length, used, segments: segments.length };
}

// -------------------------------------------------------------------------
// 4. OpenLineage files — dataset edges the ledger does not carry.
// -------------------------------------------------------------------------
function foldOpenLineage(execs, bennyHome, workspace) {
  const dir = path.join(bennyHome, "workspaces", workspace, "longview", "lineage");
  const out = [];
  for (const name of ["openlineage.json", "openlineage_runtime.json"]) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
    const evs = Array.isArray(raw) ? raw : raw.events || raw.runEvents || [];
    out.push({ file: name, events: evs.length });
    for (const e of evs) {
      const id = (e.run || {}).runId;
      if (!id) continue;
      const ex = execs.get(id) || blankExec(id, classify((e.job || {}).name || id));
      ex.event_count += 1;
      if (!ex.contract_name && e.job) ex.contract_name = e.job.name;
      if (!ex.workspace) ex.workspace = workspace;
      const ts = iso(e.eventTime);
      if (ts && (!ex.started || ts < ex.started)) ex.started = ts;
      if (ts && (!ex.ended || ts > ex.ended)) ex.ended = ts;
      for (const f of Object.values((e.run || {}).facets || {})) {
        if (f && typeof f === "object") {
          if (f.git_commit) ex.git_commit = f.git_commit;
          if (f.model) ex.model = f.model;
        }
      }
      for (const i of e.inputs || []) if (i && i.name && !ex.inputs.includes(i.name)) ex.inputs.push(i.name);
      for (const o of e.outputs || []) if (o && o.name && !ex.outputs.includes(o.name)) ex.outputs.push(o.name);
      const et = String(e.eventType || "").toUpperCase();
      if (et === "COMPLETE") ex.status = "completed";
      else if (et === "FAIL") ex.status = "failed";
      execs.set(id, ex);
    }
  }
  return out;
}

// -------------------------------------------------------------------------
// 4b. Contract binding — the traceability the regulator flagged as missing.
//
// ROOT CAUSE: a run folder's manifest.json is an INSTANTIATED manifest
// (id "enrich-sessions_v1-20260716150448", name "Knowledge Enrichment — sessions_v1")
// with no field pointing back to the TEMPLATE it was materialised from
// ("knowledge-enrichment-pipeline-v2"). So no execution could be traced to its
// governing contract. The durable fix is to stamp `template_id` at instantiation;
// until then we bind by evidence and RECORD THE METHOD AND CONFIDENCE, so a
// derived binding is never mistaken for a declared one.
// -------------------------------------------------------------------------
const NAME_STOP = new Set(["the", "and", "pipeline", "workflow", "report", "v2", "v3", "—", "-"]);
const tokens = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/)
  .filter((t) => t.length > 2 && !NAME_STOP.has(t));

export function bindContract(ex, contracts) {
  // 1. declared — an explicit template pointer (exact, highest confidence)
  if (ex.template_id && contracts[ex.template_id]) {
    return { contract_file: contracts[ex.template_id].file, contract_id: ex.template_id,
             method: "declared_template_id", confidence: 1.0 };
  }
  // 2. exact id/name match against the catalog
  for (const c of Object.values(contracts)) {
    if (ex.contract_id === c.id || ex.contract_name === c.name) {
      return { contract_file: c.file, contract_id: c.id, method: "exact_identity", confidence: 1.0 };
    }
  }
  // 2b. execution-id identity — run ids are minted from the contract they run
  // ("togaf-epic-v6-20260731070824" -> "togaf-epic-v6-engineered"). This must beat
  // the producer heuristic: every SAD version emits producer "togaf_epic.py", which
  // otherwise binds v5 and v6 runs to the v2 contract.
  const stem = String(ex.execution_id || "").replace(/-?\d{8,}$/, "").replace(/-$/, "");
  if (stem.length >= 6) {
    for (const c of Object.values(contracts)) {
      const cid = String(c.id || "");
      if (cid && (cid.startsWith(stem) || stem.startsWith(cid))) {
        return { contract_file: c.file, contract_id: c.id, method: "execution_id_identity",
                 confidence: 0.95 };
      }
    }
  }
  // 3. task-set evidence — what the execution ACTUALLY ran vs what a contract declares
  const executed = new Set(ex.processes.map((p) => String(p.node_id)).filter(Boolean));
  let best = null;
  if (executed.size) {
    for (const c of Object.values(contracts)) {
      const declared = new Set(c.tasks.map((t) => t.id));
      if (!declared.size) continue;
      let hit = 0;
      for (const t of executed) if (declared.has(t)) hit++;
      if (!hit) continue;
      const score = hit / executed.size;             // share of executed steps the contract declares
      if (!best || score > best.score || (score === best.score && declared.size < best.declared)) {
        best = { c, score, hit, declared: declared.size };
      }
    }
  }
  if (best && best.score >= 0.6) {
    return { contract_file: best.c.file, contract_id: best.c.id, method: "task_set_evidence",
             confidence: Math.round(best.score * 100) / 100,
             matched_tasks: best.hit, declared_tasks: best.declared };
  }
  // 4. name-token overlap (weakest; only when it is decisive)
  const et = tokens(ex.contract_name);
  if (et.length) {
    let nb = null;
    for (const c of Object.values(contracts)) {
      const ct = tokens(c.name);
      if (!ct.length) continue;
      const inter = et.filter((t) => ct.includes(t)).length;
      const score = inter / Math.max(et.length, ct.length);
      if (score > 0 && (!nb || score > nb.score)) nb = { c, score };
    }
    if (nb && nb.score >= 0.5) {
      return { contract_file: nb.c.file, contract_id: nb.c.id, method: "name_tokens",
               confidence: Math.round(nb.score * 100) / 100 };
    }
  }
  // 5. producer -> executor (SAD builds: producer togaf_epic.py)
  if (ex.producer) {
    const p = String(ex.producer).toLowerCase();
    for (const c of Object.values(contracts)) {
      if (c.executor && p && c.executor.toLowerCase().includes(p.replace(/\.py$/, ""))) {
        return { contract_file: c.file, contract_id: c.id, method: "producer_executor", confidence: 0.6 };
      }
    }
  }
  return { contract_file: null, contract_id: ex.contract_id || null, method: "unbound", confidence: 0 };
}

// -------------------------------------------------------------------------
// 5. Build
// -------------------------------------------------------------------------
export function buildRegister({ repoRoot, bennyHome, workspace }) {
  const contracts = loadContracts(repoRoot);
  const execs = new Map();
  foldRunRecords(execs, bennyHome, workspace, contracts);
  const ledger = foldLedger(execs, repoRoot, contracts);
  const ol = foldOpenLineage(execs, bennyHome, workspace);

  const executions = [...execs.values()].map((ex) => {
    ex.duration_s = ex.duration_s ?? secsBetween(ex.started, ex.ended);
    ex.type_label = EXEC_TYPES[ex.type] || ex.type;
    const b = bindContract(ex, contracts);
    ex.contract_file = b.contract_file;
    ex.contract_id = b.contract_id;
    ex.contract_binding = { method: b.method, confidence: b.confidence,
                            matched_tasks: b.matched_tasks ?? null,
                            declared_tasks: b.declared_tasks ?? null };
    ex.process_count = ex.processes.length;
    ex.failed_processes = ex.processes.filter((p) => p.status === "failed").length;
    // COVERAGE: did the execution run what the contract declared?
    const c = ex.contract_id ? contracts[ex.contract_id] : null;
    ex.contract_coverage = c && c.declared_task_count
      ? { declared: c.declared_task_count, executed: ex.process_count,
          pct: Math.round((100 * ex.process_count) / c.declared_task_count) }
      : null;
    return ex;
  }).sort((a, b) => String(b.started || "").localeCompare(String(a.started || "")));

  const byType = {};
  for (const e of executions) byType[e.type] = (byType[e.type] || 0) + 1;
  const datasets = {};
  for (const e of executions) {
    for (const i of e.inputs) (datasets[i] = datasets[i] || { produced_by: [], consumed_by: [] }).consumed_by.push(e.execution_id);
    for (const o of e.outputs) (datasets[o] = datasets[o] || { produced_by: [], consumed_by: [] }).produced_by.push(e.execution_id);
  }

  return {
    schema: "prime-silo/execution-contract-register/1.0",
    generated_at: new Date().toISOString(),
    workspace,
    sources: {
      governance_log: { lines: ledger.lines || 0, events_used: ledger.used || 0, segments: ledger.segments || 0 },
      openlineage: ol,
      run_records: executions.filter((e) => e.evidence.length).length,
      contracts: Object.keys(contracts).length
    },
    totals: {
      executions: executions.length,
      by_type: byType,
      processes: executions.reduce((n, e) => n + e.process_count, 0),
      failed_processes: executions.reduce((n, e) => n + e.failed_processes, 0),
      bound_to_contract: executions.filter((e) => e.contract_file).length,
      binding_methods: executions.reduce((acc, e) => {
        const m = (e.contract_binding || {}).method || "unbound";
        acc[m] = (acc[m] || 0) + 1;
        return acc;
      }, {}),
      datasets: Object.keys(datasets).length,
      integrity_hashed_events: executions.reduce((n, e) => n + e.integrity.hashed_events, 0),
      integrity_hashed_records: executions.reduce((n, e) => n + e.integrity.hashed_records, 0)
    },
    contracts,
    executions,
    datasets
  };
}

// --- CLI ------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("exec_register.mjs")) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const repoRoot = arg("--repo", path.resolve(path.dirname(process.argv[1]), "..", "..", ".."));
  const bennyHome = arg("--home", process.env.BENNY_HOME || "");
  const workspace = arg("--workspace", process.env.LONGVIEW_WORKSPACE || "sessions_v1");
  const reg = buildRegister({ repoRoot, bennyHome, workspace });
  const outPath = arg("--out", path.join(bennyHome, "workspaces", workspace, "longview", "lineage", "execution_register.json"));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(reg, null, 1), "utf8");
  if (process.argv.includes("--json")) console.log(JSON.stringify(reg.totals, null, 1));
  else {
    console.log(`Execution Contract Register -> ${outPath}`);
    console.log(`  executions        : ${reg.totals.executions}`);
    console.log(`  by type           : ${JSON.stringify(reg.totals.by_type)}`);
    console.log(`  processes         : ${reg.totals.processes} (${reg.totals.failed_processes} failed)`);
    console.log(`  bound to contract : ${reg.totals.bound_to_contract}/${reg.totals.executions}`);
    console.log(`  datasets          : ${reg.totals.datasets}`);
    console.log(`  contracts known   : ${reg.sources.contracts}`);
    console.log(`  integrity         : ${reg.totals.integrity_hashed_events} hashed events, ${reg.totals.integrity_hashed_records} hashed records`);
  }
}
