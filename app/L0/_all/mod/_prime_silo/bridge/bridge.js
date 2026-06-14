// Phase B-Bridge — the Bridge cockpit (#/_prime_silo/bridge).
//
// One page that ropes the whole cognitive mesh into a single calm surface so
// the operator stops being the glue between scattered pages. Six modes down
// the rail, one stage in the middle, Benny (the onscreen agent) in the dock on
// the right. Almost entirely composition of shipped widgets — the only new
// logic is the Flows plan->run wiring, the Documents ingest->triples wiring,
// and the Benny context bridge (bridge-context.js).
//
// Modes map onto the mesh so the mental model stays small:
//   Pulse      — mesh vitals + the Memo-Ray lifelog activity feed (the landing)
//   Memory     — session lineage graph (memoray.lineage_graph)        [memory graph]
//   Documents  — workspace + files + ingest -> semantic triples (kg3d) [knowledge graph]
//   Code 3D    — Tree-Sitter code graph (codegraph.canvas, 2D/3D)      [code graph]
//   Flows      — requirement -> Plan (DAG) -> Run (observability)      [act]
//   Runs       — run lineage timeline + reasoning trace                [observe]
//
// Graph modes default to the dependency-free 2D SVG renderer (offline-safe,
// honouring the local-first guard) with a 2D/3D toggle that swaps in the
// three_renderer WebGL scene on demand.

import { runtimeFetch, readRuntimeJson } from "../runtime_client/runtime-client.js";
import {
  memorayFetch,
  readMemorayJson,
  isMemorayOffline,
  isMemorayDisabled
} from "../memoray_client/memoray-client.js";
import { createOverviewCardsWidget } from "../widgets/memoray/overview_cards/index.js";
import { createLineageGraphWidget } from "../widgets/memoray/lineage_graph/index.js";
import { createCodeGraphCanvasWidget } from "../widgets/codegraph/canvas/index.js";
import { createSynopticWebWidget } from "../widgets/kg3d/synoptic_web/index.js";
import { createDagCanvasWidget } from "../widgets/dag/canvas/index.js";
import { createLineageTimelineWidget } from "../widgets/run/lineage_timeline/index.js";
import { createReasoningTraceWidget } from "../widgets/run/reasoning_trace/index.js";
import { createThreeRenderer } from "../widgets/three_renderer/index.js";
import { mapManifestToDagData } from "../manifest_explorer/manifest-mapping.js";
import { createBridgeContext, bridgeDeepLink } from "./bridge-context.js";

export const MODES = [
  { id: "pulse", label: "Pulse", icon: "monitoring" },
  { id: "memory", label: "Memory", icon: "bubble_chart" },
  { id: "documents", label: "Documents", icon: "description" },
  { id: "code", label: "Code 3D", icon: "account_tree" },
  { id: "flows", label: "Flows", icon: "alt_route" },
  { id: "runs", label: "Runs", icon: "timeline" }
];

// Mode-aware Benny suggestion chips. `instruction` is the human-facing intent;
// bridge-context appends the live mode/selection/workspace before dispatch.
export const CHIPS = {
  pulse: [
    { label: "Tour this project", instruction: "Give me a tour of this project: what Benny is, the workflows I have, and where to start. Load the project-guide skill." },
    { label: "What did I work on?", instruction: "Summarise what I worked on most recently across my agent sessions and git activity." },
    { label: "Is the mesh healthy?", instruction: "Check the integration conformance and tell me if anything has drifted, with the owner file to fix." }
  ],
  memory: [
    { label: "What did I work on?", instruction: "Summarise my most recent agent sessions and link the most relevant ones." },
    { label: "Sessions that touched a file…", instruction: "Find which sessions touched a file I name and link each one." }
  ],
  documents: [
    { label: "Ingest these docs", instruction: "Walk me through ingesting the documents in the current workspace into the knowledge graph as semantic triples." },
    { label: "What's in this workspace?", instruction: "Summarise the documents and concepts in the current workspace." },
    { label: "Query the docs", instruction: "Answer a question using the ingested documents in the current workspace." }
  ],
  code: [
    { label: "Explain this graph", instruction: "Explain the code graph I'm looking at and the role of the selected node." },
    { label: "What depends on this?", instruction: "Describe what depends on the selected code node and what it depends on." }
  ],
  flows: [
    { label: "Help me phrase a requirement", instruction: "Help me phrase a clear requirement for a pipeline I can then plan and run." },
    { label: "Re-run the last manifest", instruction: "Re-run the most recent manifest and report the outcome." }
  ],
  runs: [
    { label: "Explain this run", instruction: "Explain what happened in the selected run, step by step." },
    { label: "Why did it fail?", instruction: "If the selected run failed, diagnose the likely cause from its lineage." }
  ]
};

/* ── pure helpers (unit-tested) ──────────────────────────────────────── */

export function readQuery(hash) {
  const out = { mode: "", id: "" };
  try {
    const h = typeof hash === "string" ? hash : (typeof window !== "undefined" && window.location ? window.location.hash : "");
    const qi = h.indexOf("?");
    if (qi < 0) return out;
    const params = new URLSearchParams(h.slice(qi + 1));
    out.mode = params.get("mode") || "";
    out.id = params.get("id") || "";
  } catch {
    /* ignore */
  }
  return out;
}

export function isValidMode(mode) {
  return MODES.some((m) => m.id === mode);
}

export function lifelogIconFor(type) {
  switch (type) {
    case "commit": return "commit";
    case "artifact": return "draft";
    case "session": return "forum";
    default: return "circle";
  }
}

export function relativeTime(ts, now = Date.now()) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const diff = Math.max(0, now - n);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function summariseRuns(runs) {
  const rows = Array.isArray(runs) ? runs : [];
  const last = rows[0] || null;
  return {
    total: rows.length,
    lastId: last ? (last.run_id || last.id || "") : "",
    lastStatus: last ? (last.status || "") : ""
  };
}

/* ── page factory ────────────────────────────────────────────────────── */

export function createBridgePage(options = {}) {
  const injected = options || {};
  return {
    modes: MODES,
    mode: "pulse",
    zen: false,
    error: "",

    // shared
    conformance: { status: "", driftCount: 0 },
    workspace: "default",
    workspaces: ["default"],
    selection: null,

    // pulse
    lifelog: [],
    lifelogState: "loading", // loading | ready | offline | disabled | error
    runsSummary: { total: 0, lastId: "", lastStatus: "" },

    // memory
    sessions: [],
    activeSessionId: "",

    // documents
    files: [],
    ingesting: false,
    ingestNote: "",
    docs3d: false,
    docsPhysics: "pinned",
    docsFocusLayer: 0, // 0 = all AoT layers, 1..5 = focus a single layer

    // code
    code3d: false,
    codePhysics: "pinned",
    // Node-type filter for the code graph. Folders→Concepts; toggling one off
    // drops it from the layout in both the 2D SVG and the 3D WebGL renderer.
    codeTypes: [
      { id: "Folder", color: "#FFD700" },
      { id: "File", color: "#00FFFF" },
      { id: "Module", color: "#94a3b8" },
      { id: "Class", color: "#007ACC" },
      { id: "Function", color: "#FF5F1F" },
      { id: "Concept", color: "#a78bfa" }
    ],
    codeVisibleTypes: ["Folder", "File", "Module", "Class", "Function", "Concept"],

    // graph chrome
    expanded: false, // pop the active graph to fill the whole view

    // flows
    requirement: "",
    strategy: "auto",
    planning: false,
    running: false,
    flowManifestId: "",
    flowNote: "",

    // runs
    runs: [],
    activeRunId: "",

    _ctx: null,
    _widgets: [],
    _codeWidget: null,
    _docsWidget: null,

    async init() {
      this._ctx = injected.context || createBridgeContext({ agent: injected.agent });
      const q = readQuery();
      if (q.id) this.selection = { id: q.id };
      const initialMode = isValidMode(q.mode) ? q.mode : (await this.resolveDefaultMode());
      this.loadConformance();
      this.loadWorkspaces();
      await this.setMode(initialMode);
    },

    async resolveDefaultMode() {
      try {
        const res = await fetch("/api/config_defaults", { credentials: "same-origin" });
        if (res.ok) {
          const body = await res.json();
          const m = body && body.bridge ? body.bridge.default_mode : "";
          if (isValidMode(m)) return m;
        }
      } catch {
        /* fall through to pulse */
      }
      return "pulse";
    },

    get chips() {
      return CHIPS[this.mode] || [];
    },

    get activeModeLabel() {
      const m = MODES.find((x) => x.id === this.mode);
      return m ? m.label : this.mode;
    },

    get bennyContextLine() {
      const sel = this.selection && (this.selection.label || this.selection.id);
      const parts = [this.activeModeLabel];
      if (sel) parts.push(sel);
      else parts.push(`workspace ${this.workspace}`);
      return parts.join(" · ");
    },

    syncContext(patch = {}) {
      if (this._ctx) {
        this._ctx.set({
          mode: this.mode,
          selection: this.selection,
          workspace: this.workspace,
          lastRun: this.activeRunId || this.runsSummary.lastId || null,
          conformance: this.conformance.status || "",
          ...patch
        });
      }
    },

    /* ── mode switching ── */

    async setMode(mode) {
      if (!isValidMode(mode)) mode = "pulse";
      this.destroyWidgets();
      this.expanded = false;
      this.mode = mode;
      this.selection = this.selection && readQuery().mode === mode ? this.selection : null;
      this.syncContext();
      await this.$nextTick();
      await this.mountStage();
    },

    async mountStage() {
      switch (this.mode) {
        case "pulse": return this.mountPulse();
        case "memory": return this.mountMemory();
        case "documents": return this.mountDocuments();
        case "code": return this.mountCode();
        case "flows": return this.mountFlows();
        case "runs": return this.mountRuns();
        default: return undefined;
      }
    },

    track(widget) {
      if (widget && typeof widget.destroy === "function") this._widgets.push(widget);
      return widget;
    },

    destroyWidgets() {
      for (const w of this._widgets) {
        try { w.destroy(); } catch { /* swallow */ }
      }
      this._widgets = [];
      this._codeWidget = null;
      this._docsWidget = null;
    },

    /* ── graph chrome (expand to fullscreen) ── */

    toggleExpand() {
      this.expanded = !this.expanded;
      // The 3D renderer (3d-force-graph) refits to its container on window
      // resize; expanding/collapsing only changes the container, so nudge it.
      this.$nextTick(() => {
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
          window.dispatchEvent(new Event("resize"));
        }
      });
    },

    onNodeSelect(id, label) {
      this.selection = id ? { id, label: label || id } : null;
      this.syncContext();
    },

    /* ── Pulse ── */

    async mountPulse() {
      const host = this.$refs.pulseCards;
      if (host) {
        this.track(createOverviewCardsWidget(host, {
          onSelectSession: (id) => { this.activeSessionId = id; this.setMode("memory"); }
        }));
      }
      this.loadLifelog();
      this.loadRuns();
    },

    async loadLifelog() {
      this.lifelogState = "loading";
      try {
        const rows = await readMemorayJson(await memorayFetch("/lifelog"));
        this.lifelog = Array.isArray(rows) ? rows.slice(0, 24) : [];
        this.lifelogState = "ready";
      } catch (err) {
        this.lifelog = [];
        this.lifelogState = isMemorayDisabled(err) ? "disabled" : isMemorayOffline(err) ? "offline" : "error";
      }
    },

    lifelogIcon(type) { return lifelogIconFor(type); },
    ago(ts) { return relativeTime(ts); },

    /* ── Memory ── */

    async mountMemory() {
      await this.loadSessions();
      if (!this.activeSessionId && this.sessions.length) {
        this.activeSessionId = this.sessions[0].id;
      }
      if (this.activeSessionId) this.mountSessionGraph(this.activeSessionId);
    },

    async loadSessions() {
      try {
        const list = await readMemorayJson(await memorayFetch("/sessions"));
        this.sessions = Array.isArray(list) ? list : [];
      } catch {
        this.sessions = [];
      }
    },

    selectSession(id) {
      this.activeSessionId = id;
      this.onNodeSelect(id, this.sessionTitle(id));
      this.mountSessionGraph(id);
    },

    sessionTitle(id) {
      const s = this.sessions.find((x) => x.id === id);
      return s ? (s.content || "Untitled") : id;
    },

    mountSessionGraph(sessionId) {
      const host = this.$refs.memoryGraph;
      if (!host) return;
      this.destroyWidgets();
      this.track(createLineageGraphWidget(host, {
        sessionId,
        onSelect: (nodeId) => this.onNodeSelect(nodeId)
      }));
    },

    /* ── Documents (workspace + files + ingest -> triples) ── */

    async mountDocuments() {
      this.loadFiles();
      this.mountKnowledgeGraph();
    },

    mountKnowledgeGraph() {
      const host = this.$refs.docsGraph;
      if (!host) return;
      this.destroyWidgets();
      this._docsWidget = this.track(createSynopticWebWidget(host, {
        workspace: this.workspace,
        focusedLayer: this.docsFocusLayer || undefined,
        onSelect: (id) => this.onNodeSelect(id)
      }, this.docs3d ? { renderer: this.makeThreeRenderer(this.docsPhysics) } : {}));
    },

    toggleDocs3d() { this.docs3d = !this.docs3d; this.mountKnowledgeGraph(); },

    toggleDocsPhysics() {
      this.docsPhysics = this.docsPhysics === "pinned" ? "fluid" : "pinned";
      this.mountKnowledgeGraph();
    },

    // Focus a single AoT layer (1..5) or clear with 0. The synoptic widget
    // re-paints in place — no refetch, no remount — so the 3D scene keeps its
    // camera. Layer visibility is honoured by both renderers.
    setDocsFocus(layer) {
      this.docsFocusLayer = layer;
      if (this._docsWidget) this._docsWidget.update({ focusedLayer: layer || undefined });
    },

    async loadFiles() {
      try {
        const body = await readRuntimeJson(await runtimeFetch(`/files?workspace=${encodeURIComponent(this.workspace)}`));
        const dataIn = body && Array.isArray(body.data_in) ? body.data_in : [];
        this.files = dataIn.map((f) => (typeof f === "string" ? { name: f } : f));
      } catch {
        this.files = [];
      }
    },

    async ingest() {
      this.ingesting = true;
      this.ingestNote = "Ingesting documents into the knowledge graph…";
      try {
        const body = await readRuntimeJson(await runtimeFetch("/rag/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace: this.workspace })
        }));
        const runId = body && (body.run_id || body.task_id || body.id);
        this.ingestNote = runId ? `Ingest started (run ${runId}). Triples will populate the graph as files are processed.` : "Ingest started.";
        // Refresh the triples view shortly after kick-off.
        setTimeout(() => this.mountKnowledgeGraph(), 1500);
      } catch (err) {
        this.ingestNote = `Ingest failed: ${err && err.message ? err.message : String(err)}`;
      } finally {
        this.ingesting = false;
      }
    },

    async correlate() {
      this.ingestNote = "Building CORRELATES_WITH edges between documents and code…";
      try {
        await readRuntimeJson(await runtimeFetch("/rag/correlate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace: this.workspace })
        }));
        this.ingestNote = "Correlation overlay built — switch to Code 3D to see the linked concepts.";
        this.mountKnowledgeGraph();
      } catch (err) {
        this.ingestNote = `Correlate failed: ${err && err.message ? err.message : String(err)}`;
      }
    },

    /* ── Code 3D ── */

    async mountCode() {
      const host = this.$refs.codeGraph;
      if (!host) return;
      this._codeWidget = this.track(createCodeGraphCanvasWidget(host, {
        workspace: this.workspace,
        selectedNodeId: this.selection ? this.selection.id : "",
        visibleTypes: [...this.codeVisibleTypes],
        onSelect: (id) => this.onNodeSelect(id)
      }, this.code3d ? { renderer: this.makeThreeRenderer(this.codePhysics) } : {}));
    },

    toggleCode3d() { this.code3d = !this.code3d; this.destroyWidgets(); this.mountCode(); },

    toggleCodePhysics() {
      this.codePhysics = this.codePhysics === "pinned" ? "fluid" : "pinned";
      this.destroyWidgets();
      this.mountCode();
    },

    // Show/hide a node type (Folder, File, Class, …). The widget re-computes
    // its layered layout from the cached graph — filtered types drop out of
    // the SVG and the 3D scene alike — so this is cheap and never refetches.
    toggleCodeType(type) {
      const idx = this.codeVisibleTypes.indexOf(type);
      if (idx >= 0) this.codeVisibleTypes.splice(idx, 1);
      else this.codeVisibleTypes.push(type);
      if (this._codeWidget) this._codeWidget.update({ visibleTypes: [...this.codeVisibleTypes] });
    },

    makeThreeRenderer(physicsMode = "pinned") {
      return createThreeRenderer({
        backgroundColor: "#14150f",
        physicsMode,
        onNodeClick: (id) => this.onNodeSelect(id)
      });
    },

    /* ── Flows (plan -> run) ── */

    async mountFlows() {
      // Stage stays empty until a plan is produced; nothing to mount yet.
    },

    async planFlow() {
      const requirement = this.requirement.trim();
      if (!requirement) { this.flowNote = "Type what you want the pipeline to do first."; return; }
      this.planning = true;
      this.flowNote = "Planning…";
      try {
        const manifest = await readRuntimeJson(await runtimeFetch("/manifests/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requirement, workspace: this.workspace, strategy: this.strategy })
        }));
        this.flowManifestId = manifest && manifest.id ? manifest.id : "";
        this.flowNote = this.flowManifestId
          ? `Planned manifest ${this.flowManifestId}. Review the DAG, then Run.`
          : "Planned, but no manifest id returned.";
        await this.$nextTick();
        const host = this.$refs.flowsDag;
        if (host) {
          this.destroyWidgets();
          this.track(createDagCanvasWidget(host, { mode: "manifest", data: mapManifestToDagData(manifest) }));
        }
        this.syncContext();
      } catch (err) {
        this.flowNote = `Plan failed: ${err && err.message ? err.message : String(err)}`;
      } finally {
        this.planning = false;
      }
    },

    async runFlow() {
      if (!this.flowManifestId) { this.flowNote = "Plan a manifest first."; return; }
      this.running = true;
      this.flowNote = "Running…";
      try {
        const res = await readRuntimeJson(await runtimeFetch(`/manifests/${encodeURIComponent(this.flowManifestId)}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace: this.workspace })
        }));
        const runId = res && (res.run_id || res.id);
        if (runId) {
          this.activeRunId = runId;
          this.flowNote = `Run ${runId} started — opening observability.`;
          this.syncContext();
          await this.setMode("runs");
        } else {
          this.flowNote = "Run started, but no run id returned.";
        }
      } catch (err) {
        this.flowNote = `Run failed: ${err && err.message ? err.message : String(err)}`;
      } finally {
        this.running = false;
      }
    },

    /* ── Runs (observability) ── */

    async mountRuns() {
      await this.loadRuns();
      if (!this.activeRunId && this.runs.length) {
        this.activeRunId = this.runs[0].run_id || this.runs[0].id || "";
      }
      if (this.activeRunId) this.mountRunWidgets(this.activeRunId);
    },

    async loadRuns() {
      try {
        const rows = await readRuntimeJson(await runtimeFetch("/manifests/runs?limit=25"));
        this.runs = Array.isArray(rows) ? rows : [];
        this.runsSummary = summariseRuns(this.runs);
      } catch {
        this.runs = [];
        this.runsSummary = summariseRuns([]);
      }
    },

    selectRun(runId) {
      this.activeRunId = runId;
      this.onNodeSelect(runId, `run ${runId}`);
      this.mountRunWidgets(runId);
    },

    mountRunWidgets(runId) {
      this.destroyWidgets();
      const timeline = this.$refs.runsTimeline;
      const trace = this.$refs.runsTrace;
      if (timeline) {
        this.track(createLineageTimelineWidget(timeline, { workspace: this.workspace, run_id: runId }));
      }
      if (trace) {
        this.track(createReasoningTraceWidget(trace, { workspace: this.workspace, run_id: runId }));
      }
    },

    /* ── workspace + conformance (shared) ── */

    async loadWorkspaces() {
      try {
        const list = await readRuntimeJson(await runtimeFetch("/workspaces"));
        const names = Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
        if (names.length) this.workspaces = names;
        if (!this.workspaces.includes(this.workspace)) this.workspace = this.workspaces[0];
      } catch {
        /* keep default */
      }
    },

    onWorkspaceChange() {
      this.syncContext();
      // Re-mount the workspace-scoped surfaces.
      if (this.mode === "documents") this.mountDocuments();
      else if (this.mode === "code") { this.destroyWidgets(); this.mountCode(); }
    },

    async loadConformance() {
      try {
        const res = await fetch("/api/integration_audit", { credentials: "same-origin" });
        if (!res.ok) { this.conformance = { status: "unknown", driftCount: 0 }; return; }
        const report = await res.json();
        const reports = report.integrations || [];
        const drift = reports.reduce((sum, r) => sum + (r.summary ? r.summary.drift : 0), 0);
        this.conformance = { status: report.status || "unknown", driftCount: drift };
        this.syncContext();
      } catch {
        this.conformance = { status: "unknown", driftCount: 0 };
      }
    },

    /* ── Benny dock ── */

    async runChip(instruction) {
      const result = await this._ctx.dispatch(instruction);
      if (!result.ok && result.reason === "agent_unavailable") {
        this.flowNote = "Benny isn't available on this page yet — open the agent dock and try again.";
      }
    },

    /* ── zen ── */

    toggleZen() { this.zen = !this.zen; },

    retry() { this.init(); },

    destroy() {
      this.destroyWidgets();
    }
  };
}

window.bridgePage = function bridgePage() {
  return createBridgePage();
};

export const __testing = {
  MODES,
  CHIPS,
  readQuery,
  isValidMode,
  lifelogIconFor,
  relativeTime,
  summariseRuns
};
