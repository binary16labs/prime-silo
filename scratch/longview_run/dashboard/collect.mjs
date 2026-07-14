// longview_v2 dashboard — COLLECT pass (read-only; no LLM, no LM-host calls).
//
// Merges the exact plan (plan.json) with live run state (ledger + cards + window
// dirs) into ONE presentation-free dashboard.json. Progress is WORK-weighted
// (windows, the honest metric) not card-count. Also aggregates the 5W from the
// finished cards: WHO (agents/models/traits), WHAT (concepts/skills/capabilities),
// WHERE (projects), WHEN (months + processing timeline). Safe to run on a loop
// alongside a live map — pure fs reads, output goes to the dashboard dir only.
import fs from "fs";
import path from "path";

const WS = process.env.LONGVIEW_WORKSPACE || "sessions_v1";
const LV = `C:/Users/nsdha/AppData/Roaming/space-agent/benny-home/benny/workspaces/${WS}/longview`;
const DASH = "C:/Users/nsdha/OneDrive/binary16/prime-silo/scratch/longview_run/dashboard";
const cardsDir = path.join(LV, "cards");
const winDir = path.join(LV, "windows");

const readJSON = (p, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return d;
  }
};
const windowsOnDisk = (sid) => {
  const d = path.join(winDir, sid);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^w\d+_\d+\.json$/.test(f)).length : 0;
};
const pctl = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] : 0);

const plan = readJSON(path.join(DASH, "plan.json"));
if (!plan) {
  console.error("[collect] no plan.json — run plan.mjs first");
  process.exit(1);
}
const planBy = Object.fromEntries(plan.sessions.map((s) => [s.sid, s]));

// --- ledger: latest ok ms per session, thin ids, wedges
const ledger = fs
  .readFileSync(path.join(LV, "ledger.jsonl"), "utf8")
  .trim()
  .split(/\r?\n/)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((e) => e);
const mapLedger = ledger.filter((e) => e.phase === "map");
const okMs = new Map();
const thinIds = new Set();
let wedges = 0;
for (const e of mapLedger) {
  if (e.status === "ok" && e.ms) okMs.set(e.session_id, e.ms);
  if (e.status === "skipped_thin") thinIds.add(e.session_id);
  if (e.action === "phase_error") wedges++;
}

// --- graph + enrich phase state (ledger + progress.json + status.json)
const statusJson = readJSON(path.join(LV, "status.json"), {});
const progress = readJSON(path.join(LV, "progress.json"), {});
const graphLedger = ledger.filter((e) => e.phase === "graph" && e.action === "upsert");
const graphOk = graphLedger.filter((e) => e.ok);
// A card can fail then succeed on a re-run — count by latest verdict per sid.
const graphBySid = new Map();
for (const e of graphLedger) graphBySid.set(e.sid, e);
const graphState = {
  cards_ok: [...graphBySid.values()].filter((e) => e.ok).length,
  cards_failed: [...graphBySid.values()].filter((e) => !e.ok).length,
  nodes_added: graphOk.reduce((a, e) => a + (e.nodes || 0), 0),
  edges_added: graphOk.reduce((a, e) => a + (e.edges || 0), 0),
  last_error: [...graphBySid.values()].filter((e) => !e.ok).slice(-1)[0]?.error || null,
  // earned per-card time + ETA only while progress.json is on the graph phase
  live: progress.phase === "graph" ? { per_item: progress.per_item_human, eta: progress.eta_human, done: progress.done, total: progress.total } : null
};
const enrichLedger = ledger.filter((e) => e.phase === "enrich");
const enrichLast = enrichLedger.slice(-1)[0] || null;
// Per-stage detail written live by graph_enrichment.EnrichProgress (todo /
// running / done / failed + counts + result per stage).
const enrichProgress = readJSON(path.join(LV, "enrich_progress.json"), null);
// Running if the node runner says so, OR the progress file is live (standalone
// `benny enrich-graph` runs bypass the runner but still write stage progress).
const progressLive =
  enrichProgress &&
  !enrichProgress.done &&
  Date.now() - new Date(enrichProgress.updated_at).getTime() < 180000;
const enrichRunning =
  progressLive ||
  (statusJson.phase === "enrich" && !(enrichLast && enrichLast.ts > (statusJson.updated_at || "")));
const enrichState = {
  running: enrichRunning,
  started: enrichRunning ? statusJson.updated_at || null : null,
  elapsed_s: enrichRunning
    ? Math.round(
        (Date.now() -
          new Date(
            (progressLive && enrichProgress.started_at) || statusJson.updated_at || Date.now()
          ).getTime()) / 1000
      )
    : null,
  ok: enrichLast ? enrichLast.ok : null,
  minutes: enrichLast && enrichLast.ms ? +(enrichLast.ms / 60000).toFixed(1) : null,
  tail: enrichLast ? enrichLast.tail : null,
  detail: enrichProgress
};

// --- live graph stats (best-effort, local benny API only — never the LM host).
// The enrich subprocess is silent, so the graph's own node/edge counts ARE the
// live progress signal: Concept count falls as merges land, similarity edges rise.
async function fetchGraphStats() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 3000);
    const r = await fetch(`http://127.0.0.1:8005/api/graph/stats?workspace=${WS}`, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
const graphStats = await fetchGraphStats();
// Rolling growth history so the dashboard can chart the graph growing/merging.
const histPath = path.join(DASH, "graph_history.json");
let graphHistory = readJSON(histPath, []);
if (graphStats) {
  const last = graphHistory[graphHistory.length - 1];
  const point = {
    ts: new Date().toISOString(),
    phase: statusJson.phase || null,
    nodes: graphStats.node_types || {},
    rels: graphStats.relationship_types || {}
  };
  const changed = !last || JSON.stringify(last.nodes) !== JSON.stringify(point.nodes) || JSON.stringify(last.rels) !== JSON.stringify(point.rels);
  if (changed) graphHistory.push(point);
  else last.ts_latest = point.ts; // record freshness without bloating the series
  if (graphHistory.length > 300) graphHistory = graphHistory.slice(-300);
  fs.writeFileSync(histPath, JSON.stringify(graphHistory));
}

// --- done cards on disk (authoritative) + aggregate their content
const doneFiles = fs
  .readdirSync(cardsDir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"));
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const concepts = new Map(),
  caps = new Map(),
  skills = new Map(),
  traits = new Map(),
  agents = new Map(),
  models = new Map();
const projects = new Map(); // name -> {sessions_done, windows_done}
const processing = []; // {sid, project, windows, s, ts}
let doneWindows = 0;
const perWindowTimes = [];

for (const f of doneFiles) {
  const sid = f.replace(/\.json$/, "");
  const card = readJSON(path.join(cardsDir, f), {});
  const meta = readJSON(path.join(cardsDir, `${sid}.meta.json`), {});
  const w = windowsOnDisk(sid);
  doneWindows += w;
  const pl = planBy[sid] || {};
  // WHERE must key on the SAME project source as the plan (inventory project),
  // or windows_done won't line up with windows_planned (was showing >100%).
  const proj = pl.project || card.project || "unknown";
  const agent = pl.agent || "unknown";
  bump(agents, agent);
  if (meta.model) bump(models, meta.model);
  for (const c of card.concepts || []) bump(concepts, c);
  for (const c of card.capabilities || []) bump(caps, c);
  for (const c of card.skills_observed || []) bump(skills, c);
  for (const c of card.operator_traits || []) bump(traits, c);
  const pd = projects.get(proj) || { sessions_done: 0, windows_done: 0 };
  pd.sessions_done++;
  pd.windows_done += w;
  projects.set(proj, pd);
  const ms = okMs.get(sid);
  if (ms && w) {
    perWindowTimes.push(ms / 1000 / w);
    processing.push({ sid: sid.slice(0, 8), project: proj, windows: w, s: Math.round(ms / 1000), ts: meta.ts || null });
  }
}

// --- WHERE: planned vs done per project (from full plan)
const projPlan = new Map();
for (const s of plan.sessions) {
  const p = projPlan.get(s.project) || { sessions: 0, windows: 0, active: 0 };
  p.sessions++;
  p.windows += s.windows;
  if (!s.thin) p.active++;
  projPlan.set(s.project, p);
}
const where = [...projPlan.entries()]
  .map(([name, p]) => {
    const d = projects.get(name) || { windows_done: 0, sessions_done: 0 };
    return {
      project: name,
      sessions: p.sessions,
      windows_planned: p.windows,
      windows_done: d.windows_done,
      pct: p.windows ? Math.round((d.windows_done / p.windows) * 100) : 0
    };
  })
  .sort((a, b) => b.windows_planned - a.windows_planned);

// --- WHEN: sessions by month (from plan ts) + processing timeline
const byMonth = new Map();
for (const s of plan.sessions) {
  if (!s.ts) continue;
  const m = new Date(s.ts).toISOString().slice(0, 7);
  const e = byMonth.get(m) || { month: m, sessions: 0, windows: 0 };
  e.sessions++;
  e.windows += s.windows;
  byMonth.set(m, e);
}

// --- composition: session-size histogram (where the work concentrates)
const buckets = [
  { label: "1", lo: 1, hi: 1 },
  { label: "2-5", lo: 2, hi: 5 },
  { label: "6-15", lo: 6, hi: 15 },
  { label: "16-40", lo: 16, hi: 40 },
  { label: "41-100", lo: 41, hi: 100 },
  { label: "100+", lo: 101, hi: 1e9 }
].map((b) => {
  const inb = plan.sessions.filter((s) => !s.thin && s.windows >= b.lo && s.windows <= b.hi);
  return { label: b.label, sessions: inb.length, windows: inb.reduce((a, s) => a + s.windows, 0) };
});

// --- run telemetry
const totalWindows = plan.totals.windows;
const remaining = totalWindows - doneWindows;
const rate = perWindowTimes.length ? perWindowTimes.reduce((a, b) => a + b, 0) / perWindowTimes.length : 0;
const p50 = pctl(perWindowTimes, 0.5),
  p25 = pctl(perWindowTimes, 0.25),
  p75 = pctl(perWindowTimes, 0.75);
const rateWorkWeighted = doneWindows ? [...okMs.entries()].reduce((a, [sid, ms]) => (doneFiles.includes(sid + ".json") ? a + ms : a), 0) / 1000 / doneWindows : rate;
const etaSec = remaining * (rateWorkWeighted || rate || 90);
const top = (m, n = 12) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));

// --- pipeline lineage: every phase with evidence-based status + ledger timings.
// "Evidence-based" = status derives from what's actually on disk (artifacts) and
// in the ledger, not from what a phase claimed. done > partial > active > todo.
const ledgerByPhase = new Map();
for (const e of ledger) {
  if (!e.phase || e.phase === "run") continue;
  const b = ledgerByPhase.get(e.phase) || { first: e.ts, last: e.ts, ok: 0, fail: 0, entries: 0 };
  if (e.ts < b.first) b.first = e.ts;
  if (e.ts > b.last) b.last = e.ts;
  if (e.ok === true || e.status === "ok") b.ok++;
  else if (e.ok === false || /error|fail/.test(e.status || "")) b.fail++;
  b.entries++;
  ledgerByPhase.set(e.phase, b);
}
const countFiles = (p, ext) => {
  try {
    return fs.readdirSync(p).filter((f) => !ext || f.endsWith(ext)).length;
  } catch {
    return 0;
  }
};
const dataOut = path.join(LV, "..", "data_out");
const activeCards = plan.totals.active;
const rollupMds = countFiles(path.join(LV, "rollups"), ".md");
const enrichDone = enrichProgress && enrichProgress.done === true && enrichProgress.ok === true;
const art = {
  reviews: countFiles(path.join(dataOut, "reviews"), ".md"),
  dossiers: countFiles(path.join(dataOut, "dossiers"), ".md"),
  skills: countFiles(path.join(dataOut, "skills")),
  book_files: countFiles(path.join(dataOut, "book")),
  pdf: countFiles(path.join(dataOut, "book"), ".pdf"),
  themes: fs.existsSync(path.join(dataOut, "THEMES.md")),
  report: fs.existsSync(path.join(dataOut, "PORTFOLIO-REPORT.md")),
  prd: fs.existsSync(path.join(dataOut, "PRD-WHAT-COMES-NEXT.md"))
};
const phaseDefs = [
  { id: "inventory", makes: "session census", done: fs.existsSync(path.join(LV, "inventory.json")), n: plan.totals.sessions, unit: "sessions" },
  { id: "extract", makes: "evidence packs", done: countFiles(path.join(LV, "evidence")) > 0, n: countFiles(path.join(LV, "evidence")), unit: "packs" },
  { id: "map", makes: "session cards", done: doneFiles.length >= activeCards, n: doneFiles.length, unit: "cards" },
  { id: "graph", makes: "knowledge graph", done: graphState.cards_ok >= doneFiles.length && doneFiles.length > 0, n: graphState.nodes_added, unit: "nodes" },
  { id: "enrich", makes: "merged concepts + themes", done: !!enrichDone, n: null, unit: "" },
  { id: "model", makes: "rollups (timeline/operator)", done: rollupMds > 0, n: rollupMds, unit: "rollups" },
  { id: "review", makes: "per-session reviews", done: art.reviews >= doneFiles.length && art.reviews > 0, n: art.reviews, unit: "reviews" },
  { id: "weave", makes: "discovery notes", done: (ledgerByPhase.get("weave") || {}).ok > 0, n: null, unit: "" },
  { id: "reduce", makes: "dossiers · skills · report · PRD", done: art.themes && art.report && art.dossiers > 0, n: art.dossiers, unit: "dossiers" },
  { id: "opus", makes: "the book (~100 sections)", done: art.book_files > 1, n: art.book_files, unit: "files" },
  { id: "pdf", makes: "print PDF", done: art.pdf > 0, n: art.pdf, unit: "pdf" }
];
const pipeline = phaseDefs.map((p) => {
  const lb = ledgerByPhase.get(p.id) || null;
  let status = p.done ? "done" : "todo";
  // enrich liveness comes from enrichState (progress-file freshness) — the
  // status.json phase can be stale for hours after a killed run.
  if (!p.done && (p.id === "enrich" ? enrichState.running : statusJson.phase === p.id)) status = "active";
  else if (!p.done && lb && lb.entries > 0) status = "partial";
  return {
    id: p.id,
    status,
    makes: p.makes,
    count: p.n,
    unit: p.unit,
    ok: lb ? lb.ok : 0,
    fail: lb ? lb.fail : 0,
    first: lb ? lb.first : null,
    last: lb ? lb.last : null
  };
});

const out = {
  generated: new Date().toISOString(),
  workspace: WS,
  pipeline,
  artifacts: art,
  phases: {
    current: statusJson.phase || "map",
    graph: graphState,
    enrich: enrichState,
    graph_stats: graphStats,
    graph_history: graphHistory.slice(-60)
  },
  run: {
    phase: statusJson.phase || "map",
    total_windows: totalWindows,
    done_windows: doneWindows,
    remaining_windows: remaining,
    pct_work: totalWindows ? Math.round((doneWindows / totalWindows) * 100) : 0,
    cards_done: doneFiles.length,
    active_sessions: plan.totals.active,
    thin: thinIds.size || plan.totals.thin,
    sessions_total: plan.totals.sessions,
    wedges,
    rate_s_per_window: Math.round(rateWorkWeighted || rate),
    eta_seconds: Math.round(etaSec),
    eta_iso: new Date(Date.now() + etaSec * 1000).toISOString()
  },
  throughput: {
    per_window_median: Math.round(p50),
    per_window_mean: Math.round(rate),
    p25: Math.round(p25),
    p75: Math.round(p75),
    stability: p50 ? +(rate / p50).toFixed(2) : null,
    recent: processing.slice(-40)
  },
  who: { agents: Object.fromEntries(agents), models: Object.fromEntries(models), operator_traits: top(traits, 8) },
  what: { concepts: top(concepts, 20), capabilities: top(caps, 12), skills: top(skills, 12) },
  where,
  when: { by_month: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)) },
  composition: buckets,
  recent_cards: processing.slice(-12).reverse()
};
fs.writeFileSync(path.join(DASH, "dashboard.json"), JSON.stringify(out, null, 2));
console.log(
  `[collect] ${out.run.pct_work}% work · ${doneWindows}/${totalWindows} windows · ${doneFiles.length} cards · ETA ${Math.round(etaSec / 3600)}h · rate ${out.run.rate_s_per_window}s/win → dashboard.json`
);
