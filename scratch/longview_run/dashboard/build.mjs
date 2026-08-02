// Build observability — the per-section truth of a book run, so nobody has to ask.
//
// WHY THIS EXISTS. Everything on this page was learned the expensive way on 2026-08-02:
//
//  1. A run wrote 5 sections with ZERO retrieved evidence and looked healthy the whole
//     time. The log said "ok, 4 cites" — they were CONCEPT citations; evidence_sources
//     was [] and cited_sids was []. GROUNDING must be a number on a screen, not something
//     you discover by opening a meta.json by hand.
//  2. A 4x slowdown got diagnosed as GPU model-thrashing and cost a live intervention on
//     the eGPU. The actual cause was visible in the data all along: arc-carrying sections
//     carry ~5.5k prompt tokens and ~2.8k completion vs ~1.2k/0.9k, because they run an
//     extra critique->revise pass. TOKENS AND CLASS must be visible next to the duration,
//     or a duration gets explained with a story instead of a cause.
//  3. The ETA quoted from an early, unrepresentative sample was out by 4x. The projection
//     here is per-CLASS (arc vs plain), because a mean over mixed classes is a fiction.
//
// Everything derives from disk — section .meta.json files and outline.json — in the same
// way the rest of this dashboard refuses to hold hidden state.

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const HOME = (process.env.BENNY_HOME || "D:/benny-home/benny").replace(/\\/g, "/");
const wsDir = (w) => `${HOME}/workspaces/${w || "sessions_v1"}`;
const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };

/** Book iterations on disk: the default output plus every iterations/<name>. */
export function iterations(w) {
  const out = [];
  const base = `${wsDir(w)}/data_out`;
  if (fs.existsSync(`${base}/sections`)) out.push({ name: "v1 (default)", dir: base });
  const iter = `${base}/iterations`;
  try {
    for (const d of fs.readdirSync(iter, { withFileTypes: true }))
      if (d.isDirectory()) out.push({ name: d.name, dir: `${iter}/${d.name}` });
  } catch { /* no iterations yet */ }
  return out;
}

/** One section's observable facts. `arc` is the CLASS that explains its cost. */
function sectionRow(dir, file) {
  const m = readJSON(path.join(dir, file));
  if (!m) return null;
  const tok = m.tokens || {};
  const sources = (m.evidence_sources || []).length;
  return {
    id: m.id || file.replace(/\.meta\.json$/, ""),
    ts: m.ts || null,
    arc: (m.arcs || []).length > 0,
    arcs: m.arcs || [],
    prompt_tokens: tok.prompt ?? null,
    completion_tokens: tok.completion ?? null,
    evidence_sources: sources,
    cited_sids: (m.cited_sids || []).length,
    cited_concepts: (m.cited_concepts || []).length,
    words: m.gate?.words ?? null,
    cites: m.gate?.cites ?? null,
    hits_arc: m.gate?.hitsArc ?? null,
    gate_errs: (m.gate?.errs || []).length,
    model: m.model || null,
    // THE CHECK THAT WAS MISSING. A section with no retrieved evidence was written from
    // the chapter brief alone. It is not a failure anywhere in the pipeline — which is
    // exactly why it has to be surfaced here.
    grounded: sources > 0
  };
}

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

// ── is it actually running? ───────────────────────────────────────────────
// ASK THE OS, DON'T INFER FROM A LOG. The house rule earned on the eGPU: a log line is
// not proof of life — a wedged process keeps its last line forever and looks identical to
// a slow one. So existence comes from the process table, and progress comes from the
// artifacts. Memoized: a PowerShell spawn per dashboard poll is what made an earlier
// endpoint take 17s.
let _proc = { at: 0, rows: null };
function opusProcesses() {
  if (Date.now() - _proc.at < 10000 && _proc.rows) return _proc.rows;
  let rows = [];
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*longview.mjs*' -and $_.CommandLine -like '*opus*' } | " +
      "Select-Object ProcessId,CreationDate,UserModeTime,KernelModeTime | ConvertTo-Json -Compress"],
      { encoding: "utf8", timeout: 15000 });
    const out = (r.stdout || "").trim();
    if (out) {
      const parsed = JSON.parse(out);
      rows = (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
        pid: p.ProcessId,
        cpu_seconds: Math.round(((p.UserModeTime || 0) + (p.KernelModeTime || 0)) / 1e7)
      }));
    }
  } catch { /* probe failure is reported as unknown, never as "not running" */ }
  _proc = { at: Date.now(), rows };
  return rows;
}

/** The most recent signed launch for this contract — ties the running process back to the
 *  human signature that authorised it, so the page shows WHO started what. */
function lastLaunch(w, contractId = "book-opus-v2") {
  try {
    const lines = fs.readFileSync(`${wsDir(w)}/longview/lineage/launch_ledger.jsonl`, "utf8")
      .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.contract_id === contractId);
    return lines.length ? lines[lines.length - 1] : null;
  } catch { return null; }
}

export function buildState(w, iterName = "v2") {
  const all = iterations(w);
  const chosen = all.find((i) => i.name === iterName) || all[0] || null;
  if (!chosen) return { workspace: w, iteration: null, iterations: all.map((i) => i.name), sections: [] };

  const secDir = `${chosen.dir}/sections`;
  let files = [];
  try { files = fs.readdirSync(secDir).filter((f) => f.endsWith(".meta.json")); } catch { /* none yet */ }

  const rows = files.map((f) => sectionRow(secDir, f)).filter(Boolean)
    .sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));

  // Duration is the GAP between consecutive completions. The first section has no
  // predecessor, so it has no measurable duration — say null rather than invent one.
  for (let i = 0; i < rows.length; i++) {
    const prev = i > 0 ? Date.parse(rows[i - 1].ts) : null;
    const cur = Date.parse(rows[i].ts);
    rows[i].seconds = prev && cur ? Math.round((cur - prev) / 1000) : null;
  }

  const outline = readJSON(`${chosen.dir}/outline.json`, null);
  const planned = outline
    ? (outline.parts || []).reduce((n, p) => n + (p.chapters || []).reduce((m, c) => m + (c.sections || []).length, 0), 0)
    : null;

  // PER-CLASS projection. A single mean over arc and plain sections is a fiction: they
  // differ by ~4x, so a mixed mean mis-projects whichever class dominates the remainder.
  const timed = rows.filter((r) => r.seconds != null);
  const arcSecs = timed.filter((r) => r.arc).map((r) => r.seconds);
  const plainSecs = timed.filter((r) => !r.arc).map((r) => r.seconds);
  const arcMean = mean(arcSecs);
  const plainMean = mean(plainSecs);

  const done = rows.length;
  const remaining = planned != null ? Math.max(0, planned - done) : null;
  // Which class are the REMAINING sections? Read it from the outline rather than assume.
  let remArc = null, remPlain = null;
  if (outline && planned != null) {
    const doneIds = new Set(rows.map((r) => r.id));
    remArc = 0; remPlain = 0;
    for (const p of outline.parts || [])
      for (const c of p.chapters || [])
        for (const s of c.sections || []) {
          if (doneIds.has(s.id)) continue;
          // a chapter's sections inherit its arc assignment; reflection sections never carry arcs
          if (s.reflection) remPlain++;
          else remArc++;
        }
  }
  const etaSeconds =
    remaining == null ? null
      : (remArc ?? 0) * (arcMean ?? plainMean ?? 0) + (remPlain ?? 0) * (plainMean ?? arcMean ?? 0);

  const ungrounded = rows.filter((r) => !r.grounded);
  const totals = {
    done,
    planned,
    remaining,
    percent: planned ? Math.round((done / planned) * 100) : null,
    grounded: rows.filter((r) => r.grounded).length,
    ungrounded: ungrounded.length,
    ungrounded_ids: ungrounded.map((r) => r.id),
    distinct_sources: new Set(rows.flatMap((r) => [])).size, // filled below
    arc_sections: rows.filter((r) => r.arc).length,
    gate_errors: rows.reduce((n, r) => n + r.gate_errs, 0),
    prompt_tokens: rows.reduce((n, r) => n + (r.prompt_tokens || 0), 0),
    completion_tokens: rows.reduce((n, r) => n + (r.completion_tokens || 0), 0),
    words: rows.reduce((n, r) => n + (r.words || 0), 0)
  };

  // Corpus coverage: which cards this book has actually drawn on. The V1 number to beat
  // is 59 of 261 (22.6%) — the reason the coverage-biased retrieval exists at all.
  const cited = new Set();
  for (const f of files) {
    const m = readJSON(path.join(secDir, f));
    for (const s of m?.evidence_sources || []) if (s.source) cited.add(String(s.source));
  }
  let cards = null;
  try {
    cards = fs.readdirSync(`${wsDir(w)}/longview/cards`)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json")).length;
  } catch { /* absent */ }
  totals.distinct_sources = cited.size;

  // RUN STATE. Completion is not stalling and absence is not failure — the two mistakes
  // the collector already had to learn. A finished build has no process and that is
  // correct; a running one with a long quiet gap is only "slow" relative to its OWN class
  // mean, not a fixed wall clock.
  const procs = opusProcesses();
  const idle = rows.length ? Math.round((Date.now() - Date.parse(rows[rows.length - 1].ts)) / 1000) : null;
  const expected = (remArc ?? 0) > 0 ? (arcMean ?? plainMean) : (plainMean ?? arcMean);
  let state, why;
  if (remaining === 0) { state = "complete"; why = "every planned section is written"; }
  else if (!procs.length) { state = "not running"; why = "no opus process — the build is stopped, not finished"; }
  else if (expected && idle != null && idle > expected * 2.5) { state = "slow"; why = `quiet ${idle}s vs ~${expected}s expected for the next section`; }
  else { state = "running"; why = idle != null ? `last section ${idle}s ago` : "started, first section in flight"; }

  const launch = lastLaunch(w);

  return {
    workspace: w,
    iteration: chosen.name,
    iterations: all.map((i) => i.name),
    dir: chosen.dir,
    run: {
      state,
      why,
      processes: procs,
      pid: procs.length ? procs[0].pid : null,
      cpu_seconds: procs.length ? procs[0].cpu_seconds : null,
      idle_seconds: idle,
      expected_seconds: expected,
      launch: launch && {
        seq: launch.seq, operator: launch.operator, ts: launch.ts,
        intent: launch.intent, signed: launch.signed
      }
    },
    totals,
    pace: {
      arc_mean_seconds: arcMean,
      plain_mean_seconds: plainMean,
      arc_sample: arcSecs.length,
      plain_sample: plainSecs.length,
      // Stated as a RANGE-free projection with its own sample size attached, so a
      // confident-looking ETA off two data points is visibly that.
      eta_seconds: etaSeconds,
      eta_hours: etaSeconds != null ? Number((etaSeconds / 3600).toFixed(1)) : null,
      remaining_arc: remArc,
      remaining_plain: remPlain,
      last_completed: rows.length ? rows[rows.length - 1].ts : null,
      idle_seconds: rows.length ? Math.round((Date.now() - Date.parse(rows[rows.length - 1].ts)) / 1000) : null
    },
    coverage: {
      distinct_cards_cited: cited.size,
      cards_total: cards,
      percent: cards ? Number(((cited.size / cards) * 100).toFixed(1)) : null,
      v1_baseline_percent: 22.6
    },
    sections: rows
  };
}
