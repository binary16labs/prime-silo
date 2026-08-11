// Workflow registry (EP-A/W) — ONE place that answers "what workflows exist, and what is the latest
// of each type?". CLI-first and canonical: the console UI and /api/workflows both read THIS module.
//
// Why it exists: the estate grew ~9 separate dashboards (dashboard/control/build/estate/flywheel/
// lineage/memory/kindle/togaf_epic_preview) and the deliverables themselves carry the version — TOGAF
// SAD reached V7, the AI Vampire book reached v2, LONGVIEW reports are rolling. Nothing listed them
// together, so "what is current?" required knowing where to look. Discovery here is DETERMINISTIC:
// scan the real artifact stores on disk, read the `.meta.json` provenance sidecars the generators
// already write (model, ts, tokens), and rank versions. No new source of truth — a reader over the
// existing evidence.
import fs from "node:fs";
import path from "node:path";

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

// $BENNY_HOME exactly as the runtime resolves it (scripts/longview/lib/config.mjs).
const BENNY_HOME = process.env.BENNY_HOME || ".benny_home";
const WORKSPACES_ROOT = path.join(BENNY_HOME, "workspaces");

// LONGVIEW_WORKSPACE is a workspace NAME (e.g. "longview_v5"), not a path — joined under
// $BENNY_HOME/workspaces. Accept an absolute path too, so a caller can point at one directly.
export function resolveWorkspace(nameOrPath) {
  const v = nameOrPath || process.env.LONGVIEW_WORKSPACE || "sessions_v1";
  if (path.isAbsolute(v) || /^[a-zA-Z]:[\\/]/.test(v)) return v;
  return path.join(WORKSPACES_ROOT, v);
}

// Artifacts are spread ACROSS workspaces (TOGAF + iterations in sessions_v1, book in longview_v5, …),
// so "what is the latest X?" is an estate-wide question, not a per-workspace one. Scan every workspace
// that actually holds deliverables.
//
// PRIVACY: workspaces marked private are EXCLUDED by default. The teleport/quarantine system moves
// personal sessions into a private workspace on purpose (see the leak gate + quarantine.json); a
// console that lists artifact titles must not drag that back into view. Count them, never read them.
const PRIVATE_RE = /(^|[_-])(private|quarantine)([_-]|$)/i;

export function listWorkspaces({ includePrivate = false } = {}) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(WORKSPACES_ROOT); } catch { return out; }
  for (const name of names) {
    const root = path.join(WORKSPACES_ROOT, name);
    if (!exists(path.join(root, "data_out")) && !exists(path.join(root, "longview"))) continue;
    const isPrivate = PRIVATE_RE.test(name);
    if (isPrivate && !includePrivate) { out.push({ name, root, private: true, scanned: false }); continue; }
    out.push({ name, root, private: isPrivate, scanned: true });
  }
  return out;
}

export const WORKSPACE = resolveWorkspace();

const DATA_OUT = (ws) => path.join(ws, "data_out");
const LONGVIEW = (ws) => path.join(ws, "longview");
const statOf = (p) => { try { return fs.statSync(p); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

// Provenance sidecar the generators write next to a deliverable (<file>.meta.json).
function meta(file) {
  const m = readJson(`${file}.meta.json`);
  if (!m) return {};
  return { model: m.model || null, ts: m.ts || null, artifact: m.artifact || null,
           tokens: m.completion_tokens ? Number(m.completion_tokens) : null };
}

function fileVersion(file, { version, label }) {
  const st = statOf(file);
  if (!st) return null;
  const m = meta(file);
  return {
    version, label: label || version,
    path: file, bytes: st.size,
    modified: st.mtime.toISOString(),
    generated: m.ts || st.mtime.toISOString(),
    model: m.model || null,
    formats: ["md", "html", "pdf"].filter((ext) => exists(file.replace(/\.md$/, `.${ext}`))),
  };
}

const byRecency = (a, b) => String(b.generated).localeCompare(String(a.generated));
const numericDesc = (a, b) => (b.rank ?? 0) - (a.rank ?? 0) || byRecency(a, b);

// ---- discoverers, one per workflow TYPE -----------------------------------

// TOGAF SAD — versions are encoded in the filename: TOGAF_EPIC_V<N>_SAD_binary16.md
function discoverTogaf(ws) {
  const dir = DATA_OUT(ws.root);
  const versions = [];
  for (const f of ls(dir)) {
    const m = f.match(/^TOGAF_EPIC_V(\d+)_SAD_(.+)\.md$/);
    if (!m) continue;
    const v = fileVersion(path.join(dir, f), { version: `v${m[1]}`, label: `V${m[1]} — ${m[2]}` });
    if (v) { v.rank = Number(m[1]); v.workspace = ws.name;
             v.state = exists(path.join(dir, `togaf_epic_v${m[1]}_state.json`)); versions.push(v); }
  }
  return { id: "togaf_sad", label: "TOGAF SAD", kind: "document",
           produces: "Solution Architecture Document (md/html/pdf)",
           generator: "scripts/longview/ (togaf epic) — see togaf-sad-v5-flow", versions };
}

// The AI Vampire book — v1 lives in data_out/book, later iterations in data_out/iterations/<name>/
function discoverBook(ws) {
  const versions = [];
  const v1 = path.join(DATA_OUT(ws.root), "book", "BOOK.md");
  const first = fileVersion(v1, { version: "v1", label: `v1 — ${ws.name}/book` });
  if (first) { first.rank = 1; first.workspace = ws.name; versions.push(first); }
  const itDir = path.join(DATA_OUT(ws.root), "iterations");
  for (const name of ls(itDir)) {
    const base = path.join(itDir, name);
    if (!statOf(base)?.isDirectory()) continue;
    const main = ["THE-AI-VAMPIRE.md", "BOOK.md"].map((f) => path.join(base, f)).find(exists);
    if (!main) continue;
    const v = fileVersion(main, { version: name, label: `${name} — ${ws.name}/iterations/${name}` });
    if (!v) continue;
    v.rank = Number((name.match(/(\d+)/) || [0, 0])[1]);
    v.workspace = ws.name;
    const cov = path.join(base, "COVERAGE.md");
    if (exists(cov)) v.coverage_report = cov;
    versions.push(v);
  }
  return { id: "ai_vampire_book", label: "The AI Vampire (book)", kind: "document",
           produces: "Long-form book + coverage report",
           generator: "scripts/longview/longview.mjs opus (LONGVIEW_OPUS_DIR per iteration)", versions };
}

// LONGVIEW rolling reports — single-file deliverables, version = their own regeneration timestamp.
function discoverLongviewReports(ws) {
  const dir = DATA_OUT(ws.root);
  const wanted = [
    ["PORTFOLIO-REPORT.md", "Portfolio report"],
    ["THEMES.md", "Themes"],
    ["TIMELINE.md", "Timeline"],
    ["PRD-WHAT-COMES-NEXT.md", "PRD — what comes next"],
  ];
  const versions = [];
  for (const [f, label] of wanted) {
    const v = fileVersion(path.join(dir, f), { version: f.replace(/\.md$/, ""), label: `${label} (${ws.name})` });
    if (v) { v.workspace = ws.name; versions.push(v); }
  }
  return { id: "longview_reports", label: "LONGVIEW reports", kind: "report",
           produces: "Portfolio / themes / timeline / PRD",
           generator: "scripts/longview/longview.mjs reduce", versions };
}

// LONGVIEW cards — the map primitive corpus (not versioned; report scale + freshness).
function discoverCards(ws) {
  const cardsDir = path.join(LONGVIEW(ws.root), "cards");
  const cards = ls(cardsDir).filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"));
  const base = { id: "longview_cards", label: "LONGVIEW cards", kind: "corpus",
                 produces: "Per-session structured cards (the map primitive)",
                 generator: "scripts/longview/longview.mjs map" };
  if (!cards.length) return { ...base, versions: [] };
  let newest = null, model = null;
  for (const f of cards.slice(-60)) { // sample the tail for freshness/model
    const m = readJson(path.join(cardsDir, f.replace(/\.json$/, ".meta.json")));
    if (m?.ts && (!newest || m.ts > newest)) { newest = m.ts; model = m.model || model; }
  }
  const q = readJson(path.join(LONGVIEW(ws.root), "quarantine.json"));
  return {
    ...base,
    versions: [{ version: `${ws.name}: ${cards.length} cards`, label: `${cards.length} cards (${ws.name})`,
                 path: cardsDir, generated: newest || null, model, workspace: ws.name,
                 rank: cards.length,
                 quarantined: Array.isArray(q?.sids) ? q.sids.length : 0 }],
  };
}

// Model ladder / bench — the EP-M + EP-A evaluation rungs committed in the repo.
function discoverLadder(repoRoot) {
  const dir = path.join(repoRoot, "docs", "bench", "rung1", "results");
  const versions = [];
  for (const f of ls(dir)) {
    if (!f.endsWith(".json") || f.includes("execution_register")) continue;
    const d = readJson(path.join(dir, f));
    if (!d?.model) continue;
    const st = statOf(path.join(dir, f));
    versions.push({ version: d.model, label: `${d.model}${f.includes("rung2") ? " (rung2)" : ""}`,
                    path: path.join(dir, f), generated: st ? st.mtime.toISOString() : null,
                    quality: d.quality_score ?? null, wall_seconds: d.wall_seconds ?? null });
  }
  versions.sort(byRecency);
  return { id: "model_ladder", label: "Model ladder (bench)", kind: "evaluation",
           produces: "Per-model quality + speed on the LONGVIEW map primitive",
           generator: "docs/bench/rung1/rung2_bench.mjs (force LONGVIEW_LLM_BASE_URL=localhost)", versions };
}

// Distillation runs — EP-A/P5 training results committed as metrics.
function discoverDistill(repoRoot) {
  const evalDir = path.join(repoRoot, "scripts", "train", "eval");
  const versions = [];
  for (const [sub, label] of [["out_p5", "P5 — LONGVIEW fragment"], ["out_ta", "EP-A — tool use"]]) {
    const d = path.join(evalDir, sub);
    for (const f of ls(d)) {
      if (!f.endsWith(".json")) continue;
      const j = readJson(path.join(d, f));
      const st = statOf(path.join(d, f));
      if (!j) continue;
      versions.push({ version: `${sub}/${f.replace(/\.json$/, "")}`, label: `${label} — ${f.replace(/\.json$/, "")}`,
                      path: path.join(d, f), generated: st ? st.mtime.toISOString() : null,
                      agg_nll: j.agg_nll ?? null, quality: j.quality_score ?? j.quality ?? null,
                      name_match: j.name_match ?? null });
    }
  }
  versions.sort(byRecency);
  return { id: "distillation", label: "Distillation runs", kind: "evaluation",
           produces: "Held-out NLL + generation metrics for tuned models",
           generator: "scripts/train/qlora/train_qlora_p5.py + scripts/train/eval/*", versions };
}

/**
 * Discover every workflow type ACROSS the estate's workspaces.
 * Returns {workspaces, generated, types:[...]} — each type carries every version found anywhere,
 * ranked so `latest` answers "what is current?" regardless of which workspace produced it.
 */
export function discoverWorkflows({ repoRoot = process.cwd(), includePrivate = false } = {}) {
  const workspaces = listWorkspaces({ includePrivate });
  const scanned = workspaces.filter((w) => w.scanned);

  // Workspace-scoped types: run each discoverer per workspace, then merge by type id.
  const merged = new Map();
  for (const ws of scanned) {
    for (const t of [discoverTogaf(ws), discoverBook(ws), discoverLongviewReports(ws), discoverCards(ws)]) {
      const prev = merged.get(t.id);
      if (prev) prev.versions.push(...t.versions);
      else merged.set(t.id, { ...t, versions: [...t.versions] });
    }
  }
  // Repo-scoped types (bench + distillation live in the repo, not a workspace).
  for (const t of [discoverLadder(repoRoot), discoverDistill(repoRoot)]) merged.set(t.id, t);

  const types = [...merged.values()].map((t) => {
    // Rank by explicit version number when the type has one, else by recency.
    const versions = t.versions.some((v) => v.rank != null)
      ? [...t.versions].sort(numericDesc)
      : [...t.versions].sort(byRecency);
    return { ...t, versions, count: versions.length, latest: versions[0] || null, available: versions.length > 0 };
  });

  return {
    generated: new Date().toISOString(),
    configured_workspace: WORKSPACE,
    workspaces: workspaces.map((w) => ({ name: w.name, scanned: w.scanned, private: w.private })),
    private_excluded: workspaces.filter((w) => w.private && !w.scanned).length,
    types,
  };
}
