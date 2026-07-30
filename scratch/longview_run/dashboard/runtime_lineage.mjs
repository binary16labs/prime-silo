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
  // CLI builds (togaf_epic.py etc.) emit the same AER stream but have no
  // RunRecord — synthesize register entries for them so the register shows
  // every document build, not only swarm runs.
  const runIds = new Set(executions.map((e) => e.run_id));
  for (const [rid, aer] of Object.entries(aerByRun)) {
    if (runIds.has(rid) || rid.startsWith("run-")) continue;
    const started = aer.steps.length ? aer.steps[0].t : "";
    executions.unshift({
      run_id: rid,
      manifest_id: "(cli)",
      manifest_name: "togaf_epic CLI build",
      workspace: "sessions_v1",
      model: "deterministic + evidence",
      status: aer.status === "completed" ? "completed" : (Date.now() - Date.parse(aer.at) > 3600e3 ? "stale" : aer.status || "running"),
      started_at: aer.at,
      duration_ms: null,
      errors: [],
      artifacts: [],
      node_states: {},
      record_path: "governance.log"
    });
  }
  executions.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));

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

  // --- v3 recursive-build progress + earned ETA (disk truth only) ----------
  // Planned = chapter plans in the state file (+ estimate for unplanned
  // chapters); completed = written sections; speed = deltas between
  // consecutive plan/write AER timestamps (EMA, LONGVIEW eta.mjs doctrine);
  // ETA = remaining items × measured EMA. Never blocks the audit data.
  let v3_progress = null;
  try {
    const statePath = `${(process.env.BENNY_HOME || "C:/Users/nsdha/AppData/Roaming/space-agent/benny-home/benny").replace(/\\/g, "/")}/workspaces/sessions_v1/data_out/togaf_epic_v3_state.json`;
    if (fs.existsSync(statePath)) {
      const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const keys = Object.keys(st.sections || {});
      const plans = keys.filter((k) => k.startsWith("plan::"));
      const written = keys.filter((k) => !k.startsWith("plan::"));
      const gatesOk = written.filter((k) => st.sections[k].gate && st.sections[k].gate.ok).length;
      const TOTAL_CHAPTERS = 7; // TOGAF_SKELETON in togaf_epic_v3.py
      const plannedSections = plans.reduce((n, k) => n + ((st.sections[k] || []).length || 0), 0);
      const avgPerChapter = plans.length ? plannedSections / plans.length : 7;
      const estTotal = Math.round(plannedSections + (TOTAL_CHAPTERS - plans.length) * avgPerChapter);
      const v3aer = Object.entries(aerByRun)
        .filter(([k]) => k.startsWith("togaf-epic-v3"))
        .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))[0];
      let ema = null, lastAt = null, currentSection = null;
      if (v3aer) {
        const items = v3aer[1].steps.filter((s) => /Executing task: (write|plan_index)/.test(s.intent));
        currentSection = items.length ? items[items.length - 1].intent.replace("Executing task: ", "") : null;
        const secs = items.map((s) => { const [h, m, x] = s.t.split(":").map(Number); return h * 3600 + m * 60 + x; });
        for (let i = 1; i < secs.length; i++) {
          let d = secs[i] - secs[i - 1];
          if (d < 0) d += 86400; // midnight wrap
          if (d > 5 && d < 3600) ema = ema === null ? d : 0.3 * d + 0.7 * ema;
        }
        lastAt = v3aer[1].at;
      }
      const remaining = Math.max(0, estTotal - written.length) + Math.max(0, TOTAL_CHAPTERS - plans.length);
      const etaMs = ema && remaining ? remaining * ema * 1000 : null;
      v3_progress = {
        chapters_planned: plans.length, chapters_total: TOTAL_CHAPTERS,
        sections_written: written.length, sections_planned: plannedSections,
        sections_est_total: estTotal, gates_ok: gatesOk,
        pct: estTotal ? Math.min(100, Math.round((written.length / estTotal) * 100)) : 0,
        ema_sec_per_item: ema ? Math.round(ema) : null,
        current: currentSection, last_event_at: lastAt,
        eta_iso: etaMs ? new Date(Date.now() + etaMs).toISOString() : null,
        eta_human: etaMs ? `${Math.floor(etaMs / 3600000)}h ${Math.round((etaMs % 3600000) / 60000)}m` : "measuring…",
        stalled: lastAt ? Date.now() - Date.parse(lastAt) > 15 * 60 * 1000 : false
      };
    }
  } catch { /* best-effort; audit data below is never blocked by progress */ }

  return {
    v3_progress,
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
