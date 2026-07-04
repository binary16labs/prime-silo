// Benny Record — step-through playback of how the pipeline made a deliverable
// (#/_prime_silo/benny_record?scope=…). ADR-005 observability layer.
//
// This is the memo-ray step_through experience pointed at Benny's OWN work: pick
// any output (a card, a book section, a dossier, or the whole run) and replay the
// exact chain that produced it — every LLM call, gate verdict, retrieval, ingest —
// one action at a time, with a plain-English caption (hero), the phase intent
// ("Why?"), the raw ledger content, a milestone scrubber, and a lineage map
// (createLineageGraphWidget) that highlights the current step.
//
// It reads two disk-truth prime-silo APIs (NOT memo-ray): GET /api/longview_record
// (captioned action timeline + lineage tree, assembled by scripts/longview/lib/
// record.mjs) and GET /api/longview_ledger?since=<line> (append-only tail). Because
// the ledger is append-only, tail-following it live IS the real-time telemetry view
// — one player for history and now. Prime-silo enrichments step_through lacks:
// gate chips, a token-burn meter, a model/ctx/commit badge, and a phase rail.
// Card/session steps cross-jump to the classic step_through on the source session.
// Deep-linkable: #/_prime_silo/benny_record?scope=<scope>[&workspace=<ws>][&live=1].

import { createLineageGraphWidget } from "../widgets/memoray/lineage_graph/index.js";

const MAX_BAR_SEGMENTS = 600;
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// A step is a milestone (marked gold on the scrubber) when it changes the shape of
// the deliverable or the run: the run was pinned, a gate failed, or a first-class
// artifact (book section, coverage report, dossier) was produced.
function isMilestone(action) {
  const c = (action && action.content) || {};
  if (c.action === "run_config") return true;
  if (c.status === "failed" || c.ok === false) return true;
  if (typeof c.artifact === "string" && /^section:/.test(c.artifact)) return true;
  if (c.artifact === "coverage") return true;
  if (c.phase === "opus" && c.artifact) return true;
  return false;
}

// The gate verdict for a step, or null. Drives the pass/FAIL chip + error list.
function gateOf(action) {
  const c = (action && action.content) || {};
  const errs = c.gate_errors || (Array.isArray(c.errors) ? c.errors : null);
  if (c.status === "failed" || c.ok === false) {
    return { pass: false, errors: errs || [] };
  }
  if (c.gate || c.status === "ok" || errs) {
    return { pass: true, errors: errs || [] };
  }
  return null;
}

function tokensOf(action) {
  if (!action) return 0;
  if (action.tokens) return Number(action.tokens) || 0;
  const c = action.content || {};
  return (Number(c.prompt_tokens) || 0) + (Number(c.completion_tokens) || 0);
}

// Human graph-delta chips for enrich/model steps ("+12 concepts, +3 links").
function graphDeltaOf(action) {
  const c = (action && action.content) || {};
  const chips = [];
  const pairs = [
    ["concepts_added", "concepts"],
    ["merged", "merged"],
    ["links_added", "links"],
    ["similarity_links", "sim links"],
    ["related_concepts", "cross-session"],
    ["relations_typed", "typed rels"]
  ];
  for (const [key, label] of pairs) {
    const v = c[key];
    const n = Array.isArray(v) ? v.length : v;
    if (typeof n === "number" && n > 0) chips.push(`+${n} ${label}`);
  }
  return chips;
}

// The pieces of a ledger entry worth showing verbatim, in a stable order, with the
// noisy/huge fields stripped so the content pane stays a calm read.
const CONTENT_HIDE = new Set([
  "action",
  "phase",
  "status",
  "ok",
  "ts",
  "ms",
  "prompt_tokens",
  "completion_tokens",
  "gate_errors"
]);

function contentBody(action) {
  const c = (action && action.content) || {};
  const lines = [];
  for (const [k, v] of Object.entries(c)) {
    if (CONTENT_HIDE.has(k)) continue;
    if (v == null || v === "") continue;
    let rendered;
    if (Array.isArray(v))
      rendered = v.length > 12 ? `${v.slice(0, 12).join(", ")} … (${v.length})` : v.join(", ");
    else if (typeof v === "object") rendered = JSON.stringify(v);
    else rendered = String(v);
    if (rendered.length > 600) rendered = `${rendered.slice(0, 600)}…`;
    lines.push(`${k}: ${rendered}`);
  }
  return lines.join("\n");
}

function bennyRecordPage() {
  return {
    state: "loading", // loading | ready | empty | error
    error: "",
    scope: "run",
    workspace: "",
    actions: [],
    lineage: { nodes: [], links: [] },
    stepIndex: 0,
    showWhy: false,
    isPlaying: false,
    speed: 2,
    showMap: true,
    tracking: true,
    graphMode: "auto",
    live: false,
    heartbeat: null,
    runConfig: null,
    _ledgerSince: 0,
    _graph: null,
    _playTimer: null,
    _liveTimer: null,
    _keyHandler: null,

    async init() {
      const q = readQuery();
      this.scope = q.scope || "run";
      this.workspace = q.workspace || "";
      this.live = q.live === "1" || q.live === "true";
      await this.loadRecord();
      this._keyHandler = (e) => this.onKey(e);
      window.addEventListener("keydown", this._keyHandler);
    },

    recordUrl() {
      const p = new URLSearchParams({ scope: this.scope });
      if (this.workspace) p.set("workspace", this.workspace);
      return `/api/longview_record?${p.toString()}`;
    },

    async loadRecord({ keepStep = false } = {}) {
      if (!keepStep) this.state = "loading";
      try {
        const res = await fetch(this.recordUrl(), { credentials: "same-origin" });
        if (!res.ok) throw new Error(`record ${res.status}`);
        const body = await res.json();
        if (body && body.error) throw new Error(body.detail || body.error);
        const rec = body.record || {};
        this.actions = Array.isArray(rec.actions) ? rec.actions : [];
        this.workspace = rec.workspace || this.workspace;
        this.lineage =
          body.lineage && Array.isArray(body.lineage.nodes)
            ? body.lineage
            : { nodes: [], links: [] };
        this.runConfig =
          (this.actions.find((a) => a.content && a.content.action === "run_config") || {})
            .content || null;
        if (this.actions.length === 0) {
          this.state = "empty";
          return;
        }
        this.state = "ready";
        if (!keepStep || this.stepIndex >= this.actions.length) {
          this.stepIndex = this.actions.length - 1; // land on the newest step
        }
        this.$nextTick(() => {
          this.mountGraph();
          this.onStepChanged();
        });
        if (this.live) this.startLive();
      } catch (err) {
        this.state = "error";
        this.error = err && err.message ? err.message : String(err);
      }
    },

    mountGraph() {
      const host = this.$refs.graph;
      if (!host || !this.showMap) return;
      if (this._graph) this._graph.destroy();
      this._graph = createLineageGraphWidget(host, {
        data: this.lineage,
        onSelect: (nodeId) => this.jumpToNode(nodeId),
        layoutMode: this.graphMode,
        forceThreshold: 60,
        highlightIds: this.currentNodeIds,
        track: this.tracking
      });
    },

    get current() {
      return this.actions[this.stepIndex] || null;
    },

    get currentNodeIds() {
      const a = this.current;
      return a && a.nodeId ? [a.nodeId] : [];
    },

    get heroText() {
      const a = this.current;
      return a ? a.caption || "(step)" : "";
    },

    get whyText() {
      const a = this.current;
      return (a && a.why) || "";
    },

    get gate() {
      return gateOf(this.current);
    },

    get graphDelta() {
      return graphDeltaOf(this.current);
    },

    get stepTokens() {
      return tokensOf(this.current);
    },

    // Running token burn up to and including the current step — the meter.
    get tokensSoFar() {
      let sum = 0;
      for (let i = 0; i <= this.stepIndex && i < this.actions.length; i++)
        sum += tokensOf(this.actions[i]);
      return sum;
    },

    get tokensTotal() {
      let sum = 0;
      for (const a of this.actions) sum += tokensOf(a);
      return sum;
    },

    // Distinct phases in order of first appearance → the progress rail. The phase
    // owning the current step is marked active; earlier ones are done.
    get phaseRail() {
      const order = [];
      const idxByPhase = new Map();
      this.actions.forEach((a, i) => {
        const ph = (a.content && a.content.phase) || a.type || "step";
        if (!idxByPhase.has(ph)) {
          idxByPhase.set(ph, i);
          order.push(ph);
        }
      });
      const curPhase =
        (this.current && this.current.content && this.current.content.phase) ||
        (this.current && this.current.type) ||
        null;
      return order.map((ph) => ({
        phase: ph,
        active: ph === curPhase,
        done: idxByPhase.get(ph) < this.stepIndex && ph !== curPhase
      }));
    },

    contentHtml() {
      const a = this.current;
      if (!a) return "";
      const body = contentBody(a);
      return body
        ? `<pre>${escapeHtml(body)}</pre>`
        : `<p class="benny-rec__muted">No further detail recorded for this step.</p>`;
    },

    fmtTokens(n) {
      const v = Number(n) || 0;
      if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
      return String(v);
    },

    fmtMs(ms) {
      const n = Number(ms) || 0;
      if (!n) return "";
      return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`;
    },

    formatTime(ts) {
      if (!ts) return "";
      const d = new Date(ts);
      return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleTimeString();
    },

    get milestoneSegments() {
      const n = this.actions.length;
      if (n === 0) return [];
      if (n <= MAX_BAR_SEGMENTS) {
        return this.actions.map((act, idx) => ({ idx, end: idx, milestone: isMilestone(act) }));
      }
      const segs = [];
      for (let b = 0; b < MAX_BAR_SEGMENTS; b++) {
        const start = Math.floor((b * n) / MAX_BAR_SEGMENTS);
        const end = Math.floor(((b + 1) * n) / MAX_BAR_SEGMENTS);
        let milestone = false;
        for (let i = start; i < end; i++) {
          if (isMilestone(this.actions[i])) {
            milestone = true;
            break;
          }
        }
        segs.push({ idx: start, end: Math.max(start, end - 1), milestone });
      }
      return segs;
    },

    segClass(seg) {
      const past = this.stepIndex >= seg.idx;
      const active = this.stepIndex >= seg.idx && this.stepIndex <= seg.end;
      return { "is-milestone": seg.milestone, past, active };
    },

    onStepChanged() {
      this.showWhy = false;
      this.highlightCurrent();
    },

    highlightCurrent() {
      if (this._graph) {
        this._graph.update({ highlightIds: this.currentNodeIds, track: this.tracking });
      }
    },

    setStep(idx) {
      const clamped = Math.max(0, Math.min(idx, this.actions.length - 1));
      if (clamped === this.stepIndex) return;
      this.stepIndex = clamped;
      this.onStepChanged();
    },

    next() {
      this.isPlaying = false;
      this.setStep(this.stepIndex + 1);
    },

    prev() {
      this.isPlaying = false;
      this.setStep(this.stepIndex - 1);
    },

    togglePlay() {
      this.isPlaying = !this.isPlaying;
      if (this._playTimer) clearInterval(this._playTimer);
      this._playTimer = null;
      if (this.isPlaying) {
        this._playTimer = setInterval(
          () => {
            if (this.stepIndex >= this.actions.length - 1) {
              this.isPlaying = false;
              clearInterval(this._playTimer);
              this._playTimer = null;
              return;
            }
            this.setStep(this.stepIndex + 1);
          },
          1000 / Math.max(1, this.speed)
        );
      }
    },

    onSpeedChange() {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.togglePlay();
      }
    },

    // ── Live mode: tail the append-only ledger. When new entries land we re-pull
    // the record (cheap, disk-backed) so the new steps arrive with proper captions
    // and lineage, then auto-advance to the newest step. Pausing = scrub history.
    toggleLive() {
      this.live = !this.live;
      if (this.live) this.startLive();
      else this.stopLive();
    },

    startLive() {
      this._ledgerSince = 0;
      if (this._liveTimer) return;
      this._liveTimer = setInterval(() => this.pollLedger(), 6000);
      this.pollLedger();
    },

    stopLive() {
      if (this._liveTimer) clearInterval(this._liveTimer);
      this._liveTimer = null;
    },

    async pollLedger() {
      try {
        const p = new URLSearchParams({ since: String(this._ledgerSince) });
        if (this.workspace) p.set("workspace", this.workspace);
        const res = await fetch(`/api/longview_ledger?${p.toString()}`, {
          credentials: "same-origin"
        });
        if (!res.ok) return;
        const body = await res.json();
        this.heartbeat = body.heartbeat || this.heartbeat;
        const grew = Number(body.next) > this._ledgerSince && this._ledgerSince > 0;
        this._ledgerSince = Number(body.next) || this._ledgerSince;
        if (grew) {
          const wasAtEnd = this.stepIndex >= this.actions.length - 1;
          await this.loadRecord({ keepStep: true });
          if (wasAtEnd) this.setStep(this.actions.length - 1);
        }
        // A finished run stops emitting; drop the poller but keep the last frame.
        if (this.heartbeat && this.heartbeat.running === false) this.stopLive();
      } catch {
        /* transient; next tick retries */
      }
    },

    liveSummary() {
      const h = this.heartbeat;
      if (!h) return this.live ? "waiting for the runner…" : "";
      const parts = [`phase ${h.phase || "?"}`];
      if (h.cards_ok != null && h.backlog_total != null)
        parts.push(`${h.cards_ok}/${h.backlog_total} cards`);
      if (h.map_failed) parts.push(`${h.map_failed} failed`);
      return parts.join(" · ");
    },

    toggleMap() {
      this.showMap = !this.showMap;
      if (this.showMap) {
        this.$nextTick(() => {
          this.mountGraph();
          this.highlightCurrent();
        });
      } else if (this._graph) {
        this._graph.destroy();
        this._graph = null;
      }
    },

    toggleTracking() {
      this.tracking = !this.tracking;
      this.highlightCurrent();
    },

    cycleGraphMode() {
      const order = ["auto", "linear", "force"];
      this.graphMode = order[(order.indexOf(this.graphMode) + 1) % order.length];
      if (this._graph) this._graph.update({ layoutMode: this.graphMode });
    },

    graphModeLabel() {
      if (this.graphMode === "linear") return "📊 Linear";
      if (this.graphMode === "force") return "🧬 Free-floating";
      return "✨ Auto graph";
    },

    // Clicking a lineage node jumps the timeline to the step that produced it.
    jumpToNode(nodeId) {
      const idx = this.actions.findIndex((a) => a.nodeId === nodeId);
      if (idx >= 0) this.setStep(idx);
    },

    // ── Cross-jump into the classic step_through on the SOURCE session. Benny
    // Record shows how the deliverable was made; step_through shows what happened
    // inside the session it drew from. Two players, one continuum.
    get sourceSessionId() {
      const a = this.current;
      if (!a || !a.nodeId) return "";
      // A card step's node is `card:<sid8>`; find the session node the lineage
      // hangs under it and read its full id from meta.session_id.
      const prefix = String(a.nodeId).startsWith("card:") ? String(a.nodeId).slice(5) : null;
      if (!prefix) return "";
      const sess = this.lineage.nodes.find(
        (n) =>
          n.type === "Session" && (n.id === `session:${prefix}` || String(n.id).endsWith(prefix))
      );
      return (sess && sess.meta && sess.meta.session_id) || "";
    },

    openSourceSession() {
      const id = this.sourceSessionId;
      if (!id) return;
      window.location.hash = `#/_prime_silo/step_through?session_id=${encodeURIComponent(id)}`;
    },

    onKey(e) {
      if (this.state !== "ready") return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        this.next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.prev();
      } else if (e.key === " ") {
        e.preventDefault();
        this.togglePlay();
      }
    },

    retry() {
      this.loadRecord();
    },

    destroy() {
      if (this._playTimer) clearInterval(this._playTimer);
      this._playTimer = null;
      this.stopLive();
      if (this._keyHandler) window.removeEventListener("keydown", this._keyHandler);
      this._keyHandler = null;
      if (this._graph) this._graph.destroy();
      this._graph = null;
    }
  };
}

// Alpine looks up the factory on `window`; guard so the module also imports
// cleanly under Node for unit testing the pure helpers below.
if (typeof window !== "undefined") window.bennyRecordPage = bennyRecordPage;

function readQuery() {
  try {
    const hash = typeof window !== "undefined" && window.location ? window.location.hash : "";
    const queryIndex = hash.indexOf("?");
    if (queryIndex < 0) return {};
    const p = new URLSearchParams(hash.slice(queryIndex + 1));
    return { scope: p.get("scope"), workspace: p.get("workspace"), live: p.get("live") };
  } catch {
    return {};
  }
}

export const __testing = {
  isMilestone,
  gateOf,
  tokensOf,
  graphDeltaOf,
  contentBody,
  readQuery,
  MAX_BAR_SEGMENTS
};
