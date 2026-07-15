// LONGVIEW lineage — deterministic governance derivation from the append-only
// ledger (longview/ledger.jsonl). ONE source of truth: every number here is a
// pure function of the committed ledger + files on disk, so the operator and
// the agent see identical state from the same artifacts (no hidden memory).
//
// Emits three views of the same events:
//   1. dag       — the pipeline as a graph: phase nodes + dataset edges, each
//                  node carrying real counts/timings/tokens/status.
//   2. openlineage — standards-compliant RunEvent[] (START/COMPLETE per phase
//                  execution) with job/run/dataset facets — real interop, not a
//                  picture. Written to lineage/openlineage.json for download.
//   3. executions — the governance register: every `node longview.mjs run`
//                  invocation (git commit, model, phases, window) with outcome.
import fs from "fs";
import path from "path";

const NS = "longview";

// Canonical pipeline DAG: phase → the dataset it produces → the phases that
// consume it. Datasets are the arrows; this topology is the contract the
// ledger stats decorate. Order is execution order.
const PIPELINE = [
  { id: "inventory", makes: "sessions", from: ["memo-ray store"], to: "session census" },
  { id: "extract", makes: "evidence", from: ["session census"], to: "evidence packs" },
  { id: "map", makes: "cards", from: ["evidence packs"], to: "session cards" },
  { id: "graph", makes: "knowledge_graph", from: ["session cards"], to: "graph (Sources+Concepts)" },
  { id: "enrich", makes: "themes", from: ["graph (Sources+Concepts)"], to: "merged concepts + themes" },
  { id: "model", makes: "rollups", from: ["session cards"], to: "rollups (timeline/operator)" },
  { id: "code", makes: "code_graph", from: ["repo"], to: "code graph + correlations" },
  { id: "review", makes: "reviews", from: ["session cards", "graph (Sources+Concepts)"], to: "per-session reviews" },
  { id: "weave", makes: "discovery", from: ["graph (Sources+Concepts)", "merged concepts + themes"], to: "discovery notes" },
  { id: "reduce", makes: "deliverables", from: ["rollups (timeline/operator)", "per-session reviews", "discovery notes", "graph (Sources+Concepts)"], to: "dossiers · themes · report · PRD · skills" },
  { id: "opus", makes: "book", from: ["dossiers · themes · report · PRD · skills", "per-session reviews", "discovery notes"], to: "the book (sections)" },
  { id: "pdf", makes: "pdf", from: ["the book (sections)"], to: "print PDF" }
];

const readLedger = (ledgerPath) => {
  try {
    return fs
      .readFileSync(ledgerPath, "utf8")
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

// Split the flat ledger into executions at each run_config marker. Everything
// after a marker (until the next) belongs to that invocation. Events before the
// first marker (older runs that predate run_config logging) form execution 0.
function splitExecutions(ledger) {
  const execs = [];
  let cur = null;
  for (const e of ledger) {
    if (e.phase === "run" && e.action === "run_config") {
      cur = {
        started_at: e.ts,
        git_commit: e.git_commit || null,
        model: e.model || null,
        workspace: e.workspace || null,
        phases_planned: e.phases || [],
        events: []
      };
      execs.push(cur);
      continue;
    }
    if (!cur) {
      cur = { started_at: e.ts, git_commit: null, model: null, phases_planned: [], events: [], preconfig: true };
      execs.push(cur);
    }
    cur.events.push(e);
  }
  return execs;
}

// Per-phase rollup within a set of events: timings, ok/fail, tokens.
function phaseStats(events) {
  const by = new Map();
  for (const e of events) {
    if (!e.phase || e.phase === "run") continue;
    const s = by.get(e.phase) || { phase: e.phase, first: e.ts, last: e.ts, ok: 0, fail: 0, events: 0, ms: 0, prompt_tokens: 0, completion_tokens: 0 };
    if (e.ts < s.first) s.first = e.ts;
    if (e.ts > s.last) s.last = e.ts;
    if (e.ok === true || e.status === "ok") s.ok++;
    else if (e.ok === false || /error|fail/.test(e.status || "")) s.fail++;
    s.events++;
    s.ms += Number(e.ms) || 0;
    s.prompt_tokens += Number(e.prompt_tokens) || 0;
    s.completion_tokens += Number(e.completion_tokens) || 0;
    by.set(e.phase, s);
  }
  return by;
}

// Build the visual DAG: nodes = phases (with live status from pipelineState) +
// datasets; edges connect producing/consuming phases through their datasets.
function buildDag(latestStats, pipelineState) {
  const stateById = new Map((pipelineState || []).map((p) => [p.id, p]));
  const nodes = [];
  const edges = [];
  const datasetSeen = new Set();
  for (const p of PIPELINE) {
    const st = stateById.get(p.id) || {};
    const s = latestStats.get(p.id) || {};
    nodes.push({
      id: p.id,
      kind: "phase",
      status: st.status || "todo",
      count: st.count ?? null,
      total: st.total ?? null,
      unit: st.unit || "",
      ok: s.ok || 0,
      fail: s.fail || 0,
      ms: s.ms || 0,
      tokens: (s.prompt_tokens || 0) + (s.completion_tokens || 0),
      first: s.first || null,
      last: s.last || null,
      produces: p.to
    });
    // Dataset node (the phase's output) + edge phase → dataset.
    if (!datasetSeen.has(p.to)) {
      nodes.push({ id: p.to, kind: "dataset" });
      datasetSeen.add(p.to);
    }
    edges.push({ from: p.id, to: p.to, kind: "produces" });
    // Edges dataset → consuming phase.
    for (const inp of p.from) {
      if (!datasetSeen.has(inp)) {
        nodes.push({ id: inp, kind: "dataset", external: !PIPELINE.some((x) => x.to === inp) });
        datasetSeen.add(inp);
      }
      edges.push({ from: inp, to: p.id, kind: "consumes" });
    }
  }
  return { nodes, edges };
}

// OpenLineage RunEvent[] — START at phase.first, COMPLETE/FAIL at phase.last.
// One run id per (execution, phase). Facets carry the domain counts so the
// events are self-describing when replayed into any OL-compatible store.
function openLineageEvents(execs) {
  const events = [];
  let execIdx = 0;
  for (const ex of execs) {
    execIdx++;
    const stats = phaseStats(ex.events);
    for (const [phase, s] of stats) {
      const runId = `${(ex.git_commit || "pre")}-${execIdx}-${phase}`;
      const producer = "https://github.com/binary16labs/prime-silo/longview";
      const job = { namespace: NS, name: phase };
      const outDef = PIPELINE.find((p) => p.id === phase);
      const outputs = outDef ? [{ namespace: NS, name: outDef.to }] : [];
      const inputs = outDef ? outDef.from.map((f) => ({ namespace: NS, name: f })) : [];
      const facets = {
        longview_stats: {
          _producer: producer,
          _schemaURL: `${producer}#stats`,
          events: s.events,
          ok: s.ok,
          fail: s.fail,
          duration_ms: s.ms,
          prompt_tokens: s.prompt_tokens,
          completion_tokens: s.completion_tokens
        }
      };
      const run = { runId, facets: { longview_execution: { _producer: producer, _schemaURL: `${producer}#exec`, git_commit: ex.git_commit, model: ex.model, workspace: ex.workspace } } };
      events.push({ eventType: "START", eventTime: s.first, producer, job, run, inputs, outputs: [] });
      events.push({
        eventType: s.fail > 0 && s.ok === 0 ? "FAIL" : "COMPLETE",
        eventTime: s.last,
        producer,
        job,
        run: { ...run, facets: { ...run.facets, ...facets } },
        inputs,
        outputs
      });
    }
  }
  return events;
}

// Public: derive the full lineage bundle from a workspace's ledger.
export function deriveLineage(ledgerPath, pipelineState) {
  const ledger = readLedger(ledgerPath);
  const execs = splitExecutions(ledger);
  const latestStats = phaseStats(ledger); // cumulative, for the DAG node stats
  const dag = buildDag(latestStats, pipelineState);
  const openlineage = openLineageEvents(execs);

  // Governance register — one row per execution, newest first.
  const executions = execs
    .map((ex, i) => {
      const stats = phaseStats(ex.events);
      const phases = [...stats.values()];
      const ok = phases.reduce((a, p) => a + p.ok, 0);
      const fail = phases.reduce((a, p) => a + p.fail, 0);
      const ms = phases.reduce((a, p) => a + p.ms, 0);
      const tokens = phases.reduce((a, p) => a + p.prompt_tokens + p.completion_tokens, 0);
      const ends = phases.map((p) => p.last).filter(Boolean).sort();
      return {
        idx: i + 1,
        started_at: ex.started_at,
        ended_at: ends[ends.length - 1] || ex.started_at,
        git_commit: ex.git_commit,
        model: ex.model,
        workspace: ex.workspace,
        phases: phases.map((p) => p.phase),
        ok,
        fail,
        duration_ms: ms,
        tokens,
        outcome: fail === 0 ? "clean" : ok > 0 ? "partial" : "failed"
      };
    })
    .reverse();

  return { dag, openlineage, executions, event_count: ledger.length };
}
