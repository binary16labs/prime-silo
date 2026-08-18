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
import { fileURLToPath } from "url";
import { deriveLineage } from "./lineage.mjs";
import { deriveRuntimeLineage } from "./runtime_lineage.mjs";

// CLI: --workspace <ws> (else LONGVIEW_WORKSPACE), --stdout (print JSON + skip the
// shared DASH side-writes so an on-demand foreign-workspace build never clobbers the
// active workspace's files), --iteration <id> (force which book iteration is active).
const _argv = process.argv.slice(2);
const _argOf = (k) => { const i = _argv.indexOf(k); return i >= 0 ? _argv[i + 1] : null; };
const STDOUT = _argv.includes("--stdout");
const ITER = _argOf("--iteration");
const WS = _argOf("--workspace") || process.env.LONGVIEW_WORKSPACE || "sessions_v1";
// Honor BENNY_HOME (the corpus moved to D:); fall back to the legacy AppData home.
const BH = (process.env.BENNY_HOME || "C:/Users/nsdha/AppData/Roaming/space-agent/benny-home/benny").replace(/\\/g, "/");
const LV = `${BH}/workspaces/${WS}/longview`;
// Location-relative: this file lives in <repo>/scratch/longview_run/dashboard.
const DASH = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DASH, "..", "..", "..");
const cardsDir = path.join(LV, "cards");
const winDir = path.join(LV, "windows");

const readJSON = (p, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return d;
  }
};
const readTextIf = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const windowsOnDisk = (sid) => {
  const d = path.join(winDir, sid);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^w\d+_\d+\.json$/.test(f)).length : 0;
};
const pctl = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] : 0);

// Prefer a per-workspace plan (plan.<ws>.json) so foreign-workspace builds use the
// right window/session denominators; fall back to the shared plan.json.
const plan = readJSON(path.join(DASH, `plan.${WS}.json`)) || readJSON(path.join(DASH, "plan.json"));
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
// Teleported (quarantined) sids keep their ledger history but no longer count
// toward THIS workspace's totals — without this filter graph/extract read
// "198/188" after a teleport.
const quarantined = new Set((readJSON(path.join(LV, "quarantine.json"), {}) || {}).sids || []);
const q8 = new Set([...quarantined].map((s) => s.slice(0, 8)));
const graphLedger = ledger.filter(
  (e) => e.phase === "graph" && e.action === "upsert" && !quarantined.has(e.sid) && !q8.has(e.sid)
);
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
    const t = setTimeout(() => ac.abort(), 8000); // Neo4j is slow under scan load; give stats room
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
// graph_history.json is a per-active-workspace series in DASH; in --stdout mode we
// neither read nor write it (a foreign-workspace poll would corrupt the chart).
const histPath = path.join(DASH, "graph_history.json");
let graphHistory = STDOUT ? [] : readJSON(histPath, []);
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
  if (!STDOUT) fs.writeFileSync(histPath, JSON.stringify(graphHistory));
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
// Rollups are JSON (operator/projects/capabilities/timeline/threads), not .md —
// operator.json is the marker the reduce phase actually depends on.
const rollupsDone = fs.existsSync(path.join(LV, "rollups", "operator.json"));
const rollupCount = countFiles(path.join(LV, "rollups"), ".json");
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
// Expected totals so every phase reads "done OF total", not a bare count.
const manifest = readJSON(
  path.join(REPO, "runtime", "manifests", "templates", "longview_synthesis.json"),
  {}
);
const weavePhase = ((manifest.plan || {}).phases || []).find((p) => p.id === "weave") || {};
const weaveTotal = (Number(weavePhase.loops) || 2) * (Number(weavePhase.questions) || 4);
const projectsRollup = readJSON(path.join(LV, "rollups", "projects.json"), null);
const projectTotal = projectsRollup
  ? Array.isArray(projectsRollup)
    ? projectsRollup.length
    : Object.keys(projectsRollup).length
  : null;
const ROLLUP_SET = 7; // projects/capabilities/timeline/operator/threads/sids/ingested
// --- book iterations: discover EVERY book output (opus/ + iterations/*), not
// just opus/ — the "can't see v2-arcs" bug was the dashboard hard-coding opus/.
// Each is reported with its own progress + coverage; the ACTIVE one (most
// recently written sections) drives the opus phase denominator.
function discoverBooks() {
  const dirs = [{ id: "opus", dir: path.join(dataOut, "opus") }];
  const itRoot = path.join(dataOut, "iterations");
  try {
    for (const name of fs.readdirSync(itRoot))
      if (fs.statSync(path.join(itRoot, name)).isDirectory())
        dirs.push({ id: `iterations/${name}`, dir: path.join(itRoot, name) });
  } catch {
    /* no iterations yet */
  }
  const books = [];
  for (const { id, dir } of dirs) {
    const ol = readJSON(path.join(dir, "outline.json"), null);
    if (!ol && !fs.existsSync(path.join(dir, "sections"))) continue;
    const planned = ol
      ? (ol.parts || []).reduce((a, p) => a + (p.chapters || []).reduce((b, c) => b + (c.sections || []).length, 0), 0) || null
      : null;
    const written = countFiles(path.join(dir, "sections"), ".md");
    // Coverage computed HERE from the assembled book (deterministic, consistent
    // across books regardless of when each COVERAGE.md was written, and immune
    // to the .meta.json double-count bug). distinct cited sids ÷ real cards.
    const bookMd = readTextIf(path.join(dir, "THE-AI-VAMPIRE.md"));
    const citedSids = new Set(
      (bookMd.match(/\(sid:\s*[a-z0-9]{6,}\s*\)/gi) || []).map((m) =>
        m.replace(/.*sid:\s*/i, "").replace(/\s*\).*/, "").slice(0, 8).toLowerCase()
      )
    );
    const realCards = fs.existsSync(path.join(LV, "cards"))
      ? fs.readdirSync(path.join(LV, "cards")).filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json")).length
      : 0;
    const coverage_pct = realCards && citedSids.size ? +((citedSids.size / realCards) * 100).toFixed(1) : null;
    const words = bookMd ? bookMd.split(/\s+/).filter(Boolean).length : null;
    const arcs = readJSON(path.join(dir, "arcs.json"), null);
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, "sections")).mtimeMs;
    } catch {
      /* */
    }
    books.push({
      id,
      baseline: id === "opus",
      arced: Boolean(arcs?.arcs?.length),
      arcs: arcs?.arcs?.length || 0,
      planned,
      written,
      pct: written && planned ? Math.round((written / planned) * 100) : null,
      sessions_cited: citedSids.size || null,
      cards_total: realCards || null,
      coverage_pct,
      words,
      pdf: countFiles(dir, ".pdf") > 0,
      mtime
    });
  }
  return books.sort((a, b) => b.mtime - a.mtime);
}
const books = discoverBooks();
// --iteration forces which book drives the opus phase/denominator; else newest.
if (ITER) { const _i = books.findIndex((b) => b.id === ITER); if (_i > 0) books.unshift(books.splice(_i, 1)[0]); }
const activeBook = books[0] || null; // most-recently-written = the live iteration
const plannedSections = activeBook?.planned ?? null;
const sectionFiles = activeBook?.written ?? 0;
const evidenceCount = countFiles(path.join(LV, "evidence"), ".md");

// Live census beats the (possibly stale) plan for denominators: inventory
// grows with each memo-ray sync and shrinks by quarantine.
const inventoryNow = (readJSON(path.join(LV, "inventory.json"), []) || []).filter(
  (s) => !quarantined.has(s.id)
).length;

const phaseDefs = [
  { id: "inventory", makes: "session census", done: fs.existsSync(path.join(LV, "inventory.json")), n: inventoryNow, total: inventoryNow, unit: "sessions" },
  { id: "extract", makes: "evidence packs", done: evidenceCount > 0, n: evidenceCount, total: inventoryNow, unit: "packs" },
  { id: "map", makes: "session cards", done: doneFiles.length >= activeCards, n: doneFiles.length, total: activeCards, unit: "cards" },
  { id: "graph", makes: "knowledge graph", done: graphState.cards_ok >= doneFiles.length && doneFiles.length > 0, n: graphState.cards_ok, total: doneFiles.length, unit: "cards → graph" },
  { id: "code", makes: "code graph (Tree-Sitter)", done: !!(graphStats && graphStats.node_types && graphStats.node_types.CodeEntity > 0), n: (graphStats && graphStats.node_types && graphStats.node_types.CodeEntity) || null, total: null, unit: "code entities" },
  { id: "enrich", makes: "merged concepts + themes", done: !!enrichDone, n: null, total: null, unit: "" },
  { id: "sad", makes: "TOGAF EPIC v7 SAD", done: fs.existsSync(path.join(dataOut, "TOGAF_EPIC_V7_SAD_binary16.pdf")), n: null, total: null, unit: "" },
  { id: "model", makes: "rollups (timeline/operator)", done: rollupsDone, n: Math.min(rollupCount, ROLLUP_SET), total: ROLLUP_SET, unit: "rollups" },
  { id: "review", makes: "per-session reviews", done: art.reviews >= doneFiles.length && art.reviews > 0, n: art.reviews, total: doneFiles.length, unit: "reviews" },
  { id: "weave", makes: "discovery notes", done: countFiles(path.join(dataOut, "discovery"), ".md") >= weaveTotal, n: countFiles(path.join(dataOut, "discovery"), ".md"), total: weaveTotal, unit: "notes" },
  { id: "reduce", makes: "dossiers · skills · report · PRD", done: art.themes && art.report && art.dossiers > 0, n: art.dossiers, total: projectTotal, unit: "dossiers", extra: `themes ${art.themes ? "✓" : "…"} · report ${art.report ? "✓" : "…"} · PRD ${art.prd ? "✓" : "…"}` },
  { id: "opus", makes: "the book (~100 sections)", done: plannedSections && sectionFiles >= plannedSections, n: sectionFiles, total: plannedSections, unit: "sections" },
  { id: "pdf", makes: "print PDF", done: art.pdf > 0, n: art.pdf, total: 1, unit: "pdf" }
];
const pipeline = phaseDefs.map((p) => {
  const lb = ledgerByPhase.get(p.id) || null;
  let status = p.done ? "done" : "todo";
  // "active" requires an actually-live runner (state files written in the last
  // 3 min) — the status.json phase alone goes stale after a killed run.
  const live =
    Math.min(
      (() => { try { return Date.now() - fs.statSync(path.join(LV, "ledger.jsonl")).mtimeMs; } catch { return Infinity; } })(),
      (() => { try { return Date.now() - fs.statSync(path.join(LV, "progress.json")).mtimeMs; } catch { return Infinity; } })(),
      (() => { try { return Date.now() - fs.statSync(path.join(LV, "enrich_progress.json")).mtimeMs; } catch { return Infinity; } })()
    ) < 180000;
  if (!p.done && (p.id === "enrich" ? enrichState.running : statusJson.phase === p.id && live)) status = "active";
  else if (!p.done && lb && lb.entries > 0) status = "partial";
  return {
    id: p.id,
    status,
    makes: p.makes,
    count: p.n,
    total: p.total ?? null,
    extra: p.extra || null,
    unit: p.unit,
    ok: lb ? lb.ok : 0,
    fail: lb ? lb.fail : 0,
    first: lb ? lb.first : null,
    last: lb ? lb.last : null
  };
});

// --- pipeline liveness: is a runner actually executing right now? Any of the
// run-state files written within the last 3 minutes counts as alive. Without
// this the rail can show a phase "active" for hours after a crashed/killed run.
const freshMs = (p) => {
  try {
    return Date.now() - fs.statSync(p).mtimeMs;
  } catch {
    return Infinity;
  }
};
// Live pipeline heartbeat (pipeline.mjs writes longview/pipeline/live.json each
// phase + every ~5s). This is the ONLY signal that spans the whole pipeline —
// the map-phase files below go stale during enrich/sad/opus, which is why the
// dashboard used to read "nothing running" for the ~10h downstream tail.
// A run mid-long-blocking-phase (e.g. sad's ~1-2h code-graph scan) can't refresh its
// heartbeat, so updated_at goes stale even though the run is alive — which made the
// dashboard read "idle". Trust the recorded pid: if the pipeline process is alive,
// the run IS running (just quiet). process.kill(pid, 0) throws ESRCH if gone, EPERM
// if alive-but-not-ours.
const pidAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
  }
};
const liveHb = readJSON(path.join(LV, "pipeline", "live.json"), null);
const pipelineLive = (() => {
  if (liveHb && liveHb.updated_at) {
    const ageSec = Math.round((Date.now() - Date.parse(liveHb.updated_at)) / 1000);
    const procAlive = pidAlive(liveHb.pid);
    return {
      running: liveHb.status === "running" && (ageSec < 180 || procAlive),
      blocking: liveHb.status === "running" && ageSec >= 180 && procAlive, // alive but in a long silent step
      proc_alive: procAlive,
      status: liveHb.status,
      current_phase: liveHb.current_phase,
      phase_index: liveHb.phase_index,
      plan: liveHb.plan || [],
      phases: liveHb.phases || [],
      tag: liveHb.tag,
      pid: liveHb.pid,
      started_at: liveHb.started_at,
      phase_started_at: liveHb.phase_started_at,
      updated_at: liveHb.updated_at,
      age_seconds: ageSec
    };
  }
  // Fallback for legacy runs with no heartbeat: map-phase file freshness.
  const fresh =
    Math.min(
      freshMs(path.join(LV, "ledger.jsonl")),
      freshMs(path.join(LV, "progress.json")),
      freshMs(path.join(LV, "enrich_progress.json"))
    ) < 180000;
  return { running: fresh, status: fresh ? "running" : null, current_phase: null, plan: [], phases: [] };
})();

// Reflect the live pipeline phase on the rail even during a long silent step:
// statusJson.phase tracks the MAP run, not the pipeline phase, so sad/opus never lit
// up as "active". If the run is live, mark its current pipeline phase active.
// The current phase is executing NOW — mark it active even if a prior run left its
// artifact on disk (a re-run's SAD/book pdf makes "done" fire from stale output).
if (pipelineLive.running && pipelineLive.current_phase) {
  for (const ph of pipeline) if (ph.id === pipelineLive.current_phase) ph.status = "active";
}

// --- ontology: named themes + type mix, refreshed when the graph changes.
// Aggregated from the lean knowledge endpoint (local API, code-free).
const prevDash = STDOUT ? {} : readJSON(path.join(DASH, "dashboard.json"), {});
let ontology = prevDash.ontology || null;
const graphChanged =
  graphStats &&
  JSON.stringify((prevDash.phases || {}).graph_stats || {}) !== JSON.stringify(graphStats);
// Skip the heavy knowledge/ontology query while a phase is mid-blocking-write (the
// code-graph scan): it competes with the run for Neo4j and just times out anyway.
if (graphStats && (graphChanged || !ontology) && !pipelineLive.blocking) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(`http://127.0.0.1:8005/api/graph/knowledge?workspace=${WS}&mode=connected`, {
      signal: ac.signal
    });
    clearTimeout(t);
    if (r.ok) {
      const g = await r.json();
      const comms = new Map();
      let unnamed = 0,
        mergedHubs = 0;
      for (const n of g.nodes || []) {
        if (n.node_type !== "Concept") continue;
        if ((n.merge_count || 1) > 1) mergedHubs++;
        const cn = n.community_name || "";
        if (!cn || /^Community \d+$/.test(cn)) unnamed++;
        else comms.set(cn, (comms.get(cn) || 0) + 1);
      }
      ontology = {
        updated: new Date().toISOString(),
        connected_concepts: (g.nodes || []).filter((n) => n.node_type === "Concept").length,
        merged_hubs: mergedHubs,
        unnamed,
        themes: [...comms.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 14)
          .map(([name, size]) => ({ name, size }))
      };
    }
  } catch {
    /* keep the previous ontology snapshot */
  }
}

// --- lineage & governance: derive the OpenLineage-format DAG + execution
// register deterministically from the ledger, and persist the standards-
// compliant events for download/replay (single source of truth = the ledger).
const lineage = deriveLineage(path.join(LV, "ledger.jsonl"), pipeline);
// Artifact index: makes dataset nodes drillable (click → pick an artifact →
// full lineage). Deterministic from disk; bounded. Maps each dataset label to
// the scopes record_cli understands (card:/section:/dossier:).
const cardsList = fs.existsSync(path.join(LV, "cards"))
  ? fs.readdirSync(path.join(LV, "cards"))
      .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
      .map((f) => {
        const c = readJSON(path.join(LV, "cards", f), {});
        return { id: `card:${f.slice(0, 8)}`, label: `${c.project || "?"} (${f.slice(0, 8)})`, project: c.project || "?" };
      })
  : [];
const dossierList = fs.existsSync(path.join(dataOut, "dossiers"))
  ? fs.readdirSync(path.join(dataOut, "dossiers"))
      .filter((f) => f.endsWith(".md") && !f.endsWith(".meta.json"))
      .map((f) => ({ id: `dossier:${f.replace(/\.md$/, "")}`, label: f.replace(/\.md$/, "").replace(/_/g, " ") }))
  : [];
const activeOutline = activeBook ? readJSON(path.join(dataOut, ...activeBook.id.split("/"), "outline.json"), null) : null;
const sectionList = activeOutline
  ? (activeOutline.parts || []).flatMap((p) =>
      (p.chapters || []).flatMap((c) => (c.sections || []).map((s) => ({ id: `section:${s.id}`, label: `§${s.id} ${s.title || ""}`.slice(0, 50) })))
    )
  : [];
const artifactIndex = {
  "session cards": cardsList,
  "dossiers · themes · report · PRD · skills": dossierList,
  "the book (sections)": sectionList
};
try {
  const olDir = path.join(LV, "lineage");
  fs.mkdirSync(olDir, { recursive: true });
  fs.writeFileSync(path.join(olDir, "openlineage.json"), JSON.stringify(lineage.openlineage, null, 2));
  // Also expose it for the dashboard's download link (same-origin) — but not in
  // --stdout mode, where it would clobber the active workspace's file.
  if (!STDOUT) fs.writeFileSync(path.join(DASH, "openlineage.json"), JSON.stringify(lineage.openlineage, null, 2));
} catch {
  /* best-effort */
}

// --- runtime swarm lineage (TOGAF SAD etc.): Marquez-free OpenLineage from
// the governance ledger + run records. Additive key; LONGVIEW path untouched.
let runtimeLineage = { executions: [], openlineage: [], event_count: 0, current: null, dag: null };
try {
  runtimeLineage = deriveRuntimeLineage();
  fs.writeFileSync(path.join(LV, "lineage", "openlineage_runtime.json"), JSON.stringify(runtimeLineage.openlineage, null, 2));
  if (!STDOUT) fs.writeFileSync(path.join(DASH, "openlineage_runtime.json"), JSON.stringify(runtimeLineage.openlineage, null, 2));
} catch {
  /* best-effort */
}

const out = {
  generated: new Date().toISOString(),
  workspace: WS,
  pipeline,
  pipeline_live: pipelineLive,
  ontology,
  books,
  lineage: { dag: lineage.dag, executions: lineage.executions, event_count: lineage.event_count, openlineage: lineage.openlineage, artifacts: artifactIndex },
  runtime_lineage: runtimeLineage,
  artifacts: art,
  phases: {
    current: statusJson.phase || "map",
    graph: graphState,
    enrich: enrichState,
    graph_stats: graphStats,
    graph_history: graphHistory.slice(-60)
  },
  // Live map run — the map's OWN status.json (authoritative for the active
  // backlog run + its self-computed ETA). A staleness light distinguishes
  // "working" from "wedged": the map rewrites status.json each session, so if
  // updated_at goes quiet far longer than one session should take, flag it.
  run_status: (() => {
    // Liveness heartbeat: the newest window-fragment mtime is the HONEST signal
    // (a fragment lands every ~90-150s while the map is alive). status.json only
    // refreshes on session completion, so a long heavy session makes it look stale
    // even though the map is fine — and a real wedge would ALSO freeze it. Take the
    // max of (newest window mtime, status.json updated_at): heavy sessions advance
    // the window clock, thin-session runs (no windows) advance the status clock.
    let newestWindowMs = 0;
    try {
      for (const name of fs.readdirSync(winDir)) {
        try { const m = fs.statSync(path.join(winDir, name)).mtimeMs; if (m > newestWindowMs) newestWindowMs = m; } catch { /* skip */ }
      }
    } catch { /* no windows dir yet */ }
    const u = statusJson.updated_at ? Date.parse(statusJson.updated_at) : null;
    // Honest heartbeat: the window-fragment clock ALONE. status.json.updated_at is
    // refreshed on events that aren't card progress (phase writes, inventory), so
    // max()'ing it in masked a mid-session engine hang as "ok" (seen on 754b514a,
    // frozen 90 min while the dash read healthy). Fall back to status only when no
    // windows exist yet (a thin-only pass writes no fragments but finishes instantly).
    const heartbeatMs = newestWindowMs || (u || 0);
    const quietSec = heartbeatMs ? Math.round((Date.now() - heartbeatMs) / 1000) : null;
    // A window every ~2-3 min when healthy: >12min quiet = watch, >30min = wedge territory.
    // COMPLETION IS NOT STALLING. A quiet window clock meant "stalled" after 30
    // min even when the map had FINISHED and nothing was pending — the dashboard
    // reported a healthy, idle estate as a hung app. Quiet only means stalled if
    // work is actually outstanding.
    const thin = statusJson.map_thin ?? 0;
    const okCards = statusJson.cards_ok ?? doneFiles.length;
    const pending = statusJson.backlog_total != null
      ? Math.max(0, statusJson.backlog_total - okCards - thin) : null;
    // What the ESTATE is doing right now, read from the ledger tail — no process
    // spawn, no LM call, so this stays safe to run during a live map.
    let activity = null;
    try {
      const dir = path.join(REPO, "runtime", "workspace");
      const seg = path.join(dir, "governance.log");
      const buf = fs.readFileSync(seg, "utf8");
      const lines = buf.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
        let e; try { e = JSON.parse(lines[i]); } catch { continue; }
        const d = e.data || {};
        if (!d.task_id) continue;
        activity = {
          task_id: d.task_id, type: d.type || null, status: d.status || null,
          message: String(d.message || "").slice(0, 160),
          at: e.timestamp || null,
          age_seconds: e.timestamp ? Math.round((Date.now() - Date.parse(e.timestamp)) / 1000) : null
        };
        break;
      }
    } catch { /* ledger optional */ }
    const estateBusy = activity && activity.age_seconds != null && activity.age_seconds < 900
      && activity.status !== "completed";

    const health = quietSec == null ? "unknown"
      : (statusJson.map_failed > 0 ? "error"
      : (pending === 0 ? (estateBusy ? "busy" : "idle")
      : quietSec > 1800 ? "stalled"
      : quietSec > 720 ? "slow" : "ok"));
    return {
      pending_sessions: pending,
      pipeline_state: pending === 0
        ? (estateBusy ? "complete — estate busy elsewhere" : "complete — nothing pending")
        : (quietSec != null && quietSec > 1800 ? "stalled with work outstanding" : "running"),
      estate_activity: activity,
      phase: statusJson.phase || null,
      backlog_total: statusJson.backlog_total ?? null,
      cards_ok: statusJson.cards_ok ?? null,        // map's ledger count (incl. later-quarantined)
      usable_cards: doneFiles.length,               // ON-DISK truth (quarantined already removed)
      quarantined_held: statusJson.cards_ok != null ? Math.max(0, statusJson.cards_ok - doneFiles.length) : null,
      map_failed: statusJson.map_failed ?? null,
      map_thin: statusJson.map_thin ?? null,
      current_session: statusJson.current_session || null,
      cards_per_hour: statusJson.cards_per_hour ?? null,
      // The map's self-computed ETA goes NEGATIVE on a delta/recovery run (the
      // static backlog plan reads "complete" while a few sessions re-map), which
      // rendered a nonsense "-4.8h". Only surface a non-negative ETA; otherwise null.
      eta_hours_remaining: (statusJson.eta_hours_remaining != null && statusJson.eta_hours_remaining >= 0)
        ? statusJson.eta_hours_remaining : null,
      eta_finish_iso: (statusJson.eta_hours_remaining != null && statusJson.eta_hours_remaining >= 0)
        ? new Date(Date.now() + statusJson.eta_hours_remaining * 3600 * 1000).toISOString() : null,
      updated_at: statusJson.updated_at || null,
      last_window_iso: newestWindowMs ? new Date(newestWindowMs).toISOString() : null,
      stale_seconds: quietSec,          // seconds since last heartbeat (window OR status)
      status_age_seconds: u ? Math.round((Date.now() - u) / 1000) : null,
      health
    };
  })(),
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
  recent_cards: processing.slice(-12).reverse(),
  // ── FLYWHEEL — the full self-learning loop: sessions → cards → dataset →
  // train → eval → serve → (feedback: data gap) → sessions. All read-only from
  // on-disk artifacts (no LM calls). Closes LONGVIEW (cards) to EP-T (training).
  flywheel: (() => {
    const dsDir = path.join(REPO, "scripts", "train", "dataset");
    const manifest = readJSON(path.join(dsDir, "manifest.json"), null);
    // Eval numbers — parse the v3 addendum from the report (normalize U+2212 → '-').
    let ev = {};
    try {
      const md = fs.readFileSync(path.join(REPO, "docs", "train", "T3-eval-report.md"), "utf8").replace(/\u2212/g, "-");
      const agg = md.match(/base agg_nll\s*([\d.]+)\s*(?:->|→)\s*tuned\s*([\d.]+)\s*\((-?[\d.]+)%\)/i);
      const a = md.match(/A_nll\s*(-?[\d.]+)%/i);
      const b = md.match(/B_nll\s*(-?[\d.]+)%/i);
      const tm = md.match(/tool-name(?:\s+exact)?\s+match\D*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/i);
      if (agg) ev = {
        base_nll: +agg[1], tuned_nll: +agg[2], agg_pct: +agg[3],
        a_pct: a ? +a[1] : null, b_pct: b ? +b[1] : null,
        tool_base: tm ? +tm[1] : null, tool_tuned: tm ? +tm[2] : null
      };
    } catch { /* report absent */ }
    // Dataset staleness: cards present now vs cards baked into the last build.
    const builtISO = manifest?.generated || null;
    const builtMs = builtISO ? Date.parse(builtISO) : 0;
    let newCards = 0;
    if (builtMs) { for (const f of doneFiles) { try { if (fs.statSync(path.join(cardsDir, f)).mtimeMs > builtMs) newCards++; } catch { /* skip */ } } }
    const REBUILD_AT = 20;
    const dsHealth = !manifest ? "none" : newCards >= REBUILD_AT ? "rebuild" : newCards > 0 ? "drifting" : "fresh";
    const artifact = (p) => { try { const s = fs.statSync(p); return { present: true, mtime: new Date(s.mtimeMs).toISOString() }; } catch { return { present: false, mtime: null }; } };
    const sft = artifact("D:/t3-merge/gguf_gguf"), dpo = artifact("D:/t5-merge/gguf_gguf");
    return {
      stages: {
        sessions: { count: statusJson.backlog_total ?? null, by_agent: statusJson.by_agent || null, machines: ["T480 (hub)", "ASUS (satellite)"] },
        cards: { usable: doneFiles.length, backlog: statusJson.backlog_total ?? null, thin: statusJson.map_thin ?? null, new_since_build: newCards },
        dataset: manifest ? {
          built: builtISO, total_rows: manifest.total_rows,
          stream_a: (manifest.streams?.A?.train || 0) + (manifest.streams?.A?.eval || 0),
          stream_b: (manifest.streams?.B?.train || 0) + (manifest.streams?.B?.eval || 0),
          cards_used: manifest.source?.a_v3?.jsoncards ?? null,
          excluded_personal: (manifest.streams?.A?.excluded_personal || 0) + (manifest.streams?.B?.excluded_personal || 0),
          leak_findings: manifest.privacy?.leak_findings ?? null, health: dsHealth
        } : { health: "none" },
        train: { sft, dpo, base: "Qwen2.5-Coder-7B" },
        eval: ev,
        serve: { model: "house/qwen2.5-coder-tuned", gguf_ready: sft.present }
      },
      // The self-correcting signal: which stage is behind + what the next turn should do.
      feedback: {
        data_gap: (ev.a_pct != null && ev.b_pct != null)
          ? (ev.a_pct > ev.b_pct
            ? `Stream A lags - A_nll ${ev.a_pct}% vs B_nll ${ev.b_pct}% (method data still scarce)`
            : `Streams balanced - A ${ev.a_pct}% and B ${ev.b_pct}%`)
          : null,
        next_action: dsHealth === "rebuild" ? `${newCards} new cards -> rebuild dataset (T2) now`
          : dsHealth === "drifting" ? `${newCards} new card(s) since last build - rebuild when ready`
          : dsHealth === "fresh" ? "dataset current with the corpus"
          : "no dataset built yet",
        loop_health: dsHealth
      }
    };
  })()
};
if (STDOUT) {
  // On-demand build for the server API — emit JSON, touch no shared files.
  process.stdout.write(JSON.stringify(out));
} else {
  // Atomic write (tmp + rename) so the server never reads a half-written file.
  const outPath = path.join(DASH, "dashboard.json");
  fs.writeFileSync(outPath + ".tmp", JSON.stringify(out, null, 2));
  fs.renameSync(outPath + ".tmp", outPath);
  console.log(
    `[collect] ${out.run.pct_work}% work · ${doneWindows}/${totalWindows} windows · ${doneFiles.length} cards · ETA ${Math.round(etaSec / 3600)}h · rate ${out.run.rate_s_per_window}s/win → dashboard.json`
  );
}
