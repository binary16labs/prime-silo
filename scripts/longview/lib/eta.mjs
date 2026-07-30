// longview_v2 — live progress + dynamic ETA.
//
// The v1 ETA was a static guess ("~100s/card × N"). v2 measures real per-item time
// and projects from it, so the number you see is earned, not assumed. State lives in
// <workspace>/longview/progress.json — the status dashboard reads it; the runner
// writes it after every item. Trust comes from three things being visible at once:
//   1. done/total and a wall-clock ETA derived from an EMA of REAL recent times,
//   2. good vs blank vs errored counts (a blank card is never hidden),
//   3. per-item graph deltas (N concepts, M edges) so you watch the graph fill.

import fs from "fs";
import path from "path";

const EMA_ALPHA = 0.3; // weight on the most recent sample; smooths reload spikes

function fmtDur(sec) {
  if (!isFinite(sec) || sec < 0) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? `${h}h${String(m).padStart(2, "0")}m`
    : m
      ? `${m}m${String(r).padStart(2, "0")}s`
      : `${r}s`;
}

export class Progress {
  constructor(file, { phase = "graph", total = 0 } = {}) {
    this.file = file;
    this.state = {
      phase,
      total,
      done: 0,
      good: 0,
      blank: 0,
      errored: 0,
      nodes: 0,
      edges: 0,
      ema_seconds: 0,
      last_seconds: 0,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      eta_iso: null,
      eta_human: "—",
      per_item_human: "—",
      recent: [] // last few { sid, seconds, edges, status }
    };
    // Resume: fold in any prior run's counters so ETA stays sane across restarts.
    try {
      const prior = JSON.parse(fs.readFileSync(file, "utf8"));
      if (prior && prior.phase === phase) {
        this.state.ema_seconds = prior.ema_seconds || 0;
        this.state.done = prior.done || 0;
        this.state.good = prior.good || 0;
        this.state.blank = prior.blank || 0;
        this.state.errored = prior.errored || 0;
        this.state.nodes = prior.nodes || 0;
        this.state.edges = prior.edges || 0;
      }
    } catch {
      /* first run */
    }
    this._flush();
  }

  // Record one processed item. status ∈ "good" | "blank" | "errored".
  record({ sid, seconds, status = "good", nodes = 0, edges = 0 } = {}) {
    const s = this.state;
    s.done += 1;
    s[status] = (s[status] || 0) + 1;
    s.nodes += nodes;
    s.edges += edges;
    s.last_seconds = seconds || 0;
    if (seconds > 0) {
      s.ema_seconds = s.ema_seconds
        ? EMA_ALPHA * seconds + (1 - EMA_ALPHA) * s.ema_seconds
        : seconds;
    }
    const remaining = Math.max(0, s.total - s.done);
    const etaSec = s.ema_seconds * remaining;
    s.eta_iso = isFinite(etaSec) ? new Date(Date.now() + etaSec * 1000).toISOString() : null;
    s.eta_human = fmtDur(etaSec);
    s.per_item_human = fmtDur(s.ema_seconds);
    s.updated_at = new Date().toISOString();
    s.recent.unshift({ sid, seconds: Math.round(seconds || 0), edges, status });
    s.recent = s.recent.slice(0, 6);
    this._flush();
    return this.line();
  }

  // One-line human status for the runner log.
  line() {
    const s = this.state;
    return (
      `[${s.phase}] ${s.done}/${s.total} · ~${s.per_item_human}/card · ETA ${s.eta_human}` +
      ` · ${s.good} good/${s.blank} blank/${s.errored} err · graph +${s.nodes}n/${s.edges}e`
    );
  }

  _flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch {
      /* progress is advisory — never let a write failure kill the run */
    }
  }
}

export { fmtDur };
export default Progress;
