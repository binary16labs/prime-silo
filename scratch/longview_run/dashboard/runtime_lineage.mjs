// Runtime swarm lineage — deterministic OpenLineage derivation for Benny
// runtime runs (TOGAF SAD swarm, report swarms, enrich pipelines) WITHOUT
// Marquez. Three disk sources of truth, all append-only or write-once:
//
//   1. runtime/workspace/governance.log      — integrity-hashed event ledger;
//      LINEAGE_* events carry REAL OpenLineage RunEvents (spec 1-0-5) emitted
//      by benny/governance/lineage.py (workflow START/COMPLETE/FAIL + per-tool
//      executions with parent-run facets).
//   2. runtime/workspace/manifests/*.json    — SwarmManifest DAGs as authored
//      (tasks, personas, waves, edges, model).
//   3. runtime/workspace/manifests/runs/*.json — RunRecord per execution
//      (status, node_states overlay, timings, artifacts).
//
// Same doctrine as lineage.mjs: every number is a pure function of files on
// disk; the operator and the agent see identical state. Additive module —
// nothing in the LONGVIEW lineage path is touched.
import fs from "fs";
import path from "path";

// The runtime tree is repo-relative (benny/persistence/run_store.py anchors on
// the package dir, NOT $BENNY_HOME — a known gotcha, see the TOGAF runbook).
const RUNTIME_WS = "C:/Users/nsdha/OneDrive/binary16/prime-silo/runtime/workspace";

const readJSON = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return d;
  }
};

const readLog = (p) => {
  try {
    return fs
      .readFileSync(p, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

export function deriveRuntimeLineage() {
  const manifestsDir = path.join(RUNTIME_WS, "manifests");
  const runsDir = path.join(manifestsDir, "runs");
  const govLog = path.join(RUNTIME_WS, "governance.log");

  // --- 1. Manifest DAGs (id → topology + config) --------------------------
  const manifests = {};
  if (fs.existsSync(manifestsDir)) {
    for (const f of fs.readdirSync(manifestsDir).filter((f) => f.endsWith(".json"))) {
      const m = readJSON(path.join(manifestsDir, f), null);
      if (!m || !m.id || !m.plan) continue;
      manifests[m.id] = {
        id: m.id,
        name: m.name || m.id,
        model: (m.config || {}).model || "?",
        workspace: m.workspace || "?",
        tasks: (m.plan.tasks || []).map((t) => ({
          id: t.id,
          persona: t.persona || null,
          wave: t.wave ?? 0,
          complexity: t.complexity || "?",
          node_type: t.node_type || "task",
          description: (t.description || "").slice(0, 140)
        })),
        edges: m.plan.edges || [],
        waves: m.plan.waves || []
      };
    }
  }

  // --- 2. Run records → executions register --------------------------------
  const executions = [];
  if (fs.existsSync(runsDir)) {
    for (const f of fs.readdirSync(runsDir).filter((f) => f.endsWith(".json"))) {
      const r = readJSON(path.join(runsDir, f), null);
      if (!r || !r.run_id) continue;
      const man = manifests[r.manifest_id] || null;
      executions.push({
        run_id: r.run_id,
        manifest_id: r.manifest_id || "?",
        manifest_name: man ? man.name : r.manifest_id,
        workspace: r.workspace || (man ? man.workspace : "?"),
        model: man ? man.model : "?",
        status: r.status || "?",
        started_at: r.started_at || null,
        updated_at: r.updated_at || r.finished_at || null,
        duration_ms: r.duration_ms || null,
        errors: (r.errors || []).slice(0, 3),
        artifacts: r.artifact_paths || [],
        node_states: r.node_states || {},
        record_path: path.join(runsDir, f)
      });
    }
  }
  executions.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));

  // --- 3. Governance ledger → OpenLineage events + enrich task registry ----
  const gov = readLog(govLog);
  const openlineage = [];
  const enrichRuns = {}; // run_id → { tasks: [], workspace }
  const aerByRun = {}; // swarm run_id → latest TASK_METADATA_UPDATE (message + aer_log)
  for (const ev of gov) {
    const t = ev.event_type || "";
    if (t === "TASK_METADATA_UPDATE" && ev.data && ev.data.type === "swarm_workflow") {
      // Wave-by-wave transparency: the swarm streams its Agent Execution
      // Record (intent/observation per step, incl. "Executing task: X") into
      // these events. Keep the LATEST snapshot per run — it carries the full
      // cumulative aer_log.
      aerByRun[ev.data.task_id] = {
        message: ev.data.message || "",
        status: ev.data.status || "",
        at: ev.timestamp,
        steps: (ev.data.aer_log || []).map((s) => ({
          t: (s.timestamp || "").slice(11, 19),
          type: s.type || "",
          intent: (s.intent || "").slice(0, 160)
        }))
      };
    }
    if (t.startsWith("LINEAGE_") && ev.data && ev.data.schemaURL) {
      openlineage.push(ev.data); // verbatim spec-compliant RunEvent
    } else if (t.startsWith("ENRICH_TASK") && ev.data) {
      const rid = ev.data.run_id || "?";
      enrichRuns[rid] = enrichRuns[rid] || { run_id: rid, workspace: ev.workspace || "?", tasks: [] };
      enrichRuns[rid].tasks.push({
        task_id: ev.data.task_id,
        status: ev.data.status,
        wave: ev.data.wave,
        elapsed_s: ev.data.elapsed_s,
        error: ev.data.error ? String(ev.data.error).slice(0, 120) : null,
        at: ev.data.timestamp || ev.timestamp
      });
    }
  }

  // --- 4. Current run: newest record still 'running' (with live elapsed).
  // Zombie guard: a 'running' record whose start is >6h old with no update is
  // a crashed run that never wrote its terminal status (e.g. killed CLI) —
  // surface it as 'stale' in the register, never as the live run.
  const STALE_MS = 6 * 3600 * 1000;
  for (const e of executions) {
    if (e.status === "running" && e.started_at && Date.now() - Date.parse(e.started_at) > STALE_MS) {
      e.status = "stale";
    }
  }
  const current = executions.find((e) => e.status === "running") || null;
  const dag = current && manifests[current.manifest_id] ? manifests[current.manifest_id] : null;
  if (current && current.started_at) {
    current.elapsed_s = Math.max(0, (Date.now() - Date.parse(current.started_at)) / 1000);
  }
  // Decorate the current DAG's tasks with whatever states the record carries,
  // upgraded live from the AER stream ("Executing task: X" ⇒ running; a later
  // "Executing task: Y" ⇒ X completed — waves are sequential in these swarms).
  if (dag && current) {
    for (const t of dag.tasks) t.status = current.node_states[t.id] || "pending";
    const aer = aerByRun[current.run_id];
    if (aer) {
      current.aer = aer;
      const order = dag.tasks.map((t) => t.id);
      let lastRunning = -1;
      for (const s of aer.steps) {
        const m = /Executing task: (\S+)/.exec(s.intent || "");
        if (m) {
          const i = order.indexOf(m[1]);
          if (i >= 0) lastRunning = Math.max(lastRunning, i);
        }
      }
      if (lastRunning >= 0) {
        for (let i = 0; i < order.length; i++) {
          const t = dag.tasks[i];
          if (t.status === "pending") t.status = i < lastRunning ? "completed" : i === lastRunning ? "running" : "pending";
        }
      }
    }
  }

  // Enrichment attributes snapshot (written by ops scripts after a correlate
  // pass — deterministic file, rendered verbatim).
  const enrichment = readJSON(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "enrichment_stats.json"), null);

  return {
    enrichment,
    executions: executions.slice(0, 40),
    enrich_runs: Object.values(enrichRuns).slice(-20),
    openlineage: openlineage.slice(-500),
    event_count: openlineage.length,
    manifests: Object.keys(manifests).length,
    current,
    dag,
    sources: { governance_log: govLog, runs_dir: runsDir }
  };
}
