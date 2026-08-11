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
import { subscribeActivity } from "../runtime_client/activity-store.js";
import {
  memorayFetch,
  readMemorayJson,
  isMemorayOffline,
  isMemorayDisabled
} from "../memoray_client/memoray-client.js";
import { createOverviewCardsWidget } from "../widgets/memoray/overview_cards/index.js";
import { createLineageGraphWidget } from "../widgets/memoray/lineage_graph/index.js";
import { createCodeGraphCanvasWidget } from "../widgets/codegraph/canvas/index.js";
import { makeAnimeOrbRenderer } from "../widgets/code_3d_v2/anime-orb-renderer.js";
import { createSynopticWebWidget } from "../widgets/kg3d/synoptic_web/index.js";
import { createDagCanvasWidget } from "../widgets/dag/canvas/index.js";
import { createWorkflowDesignerWidget } from "../widgets/workflow_designer/index.js";
import { createLineageTimelineWidget } from "../widgets/run/lineage_timeline/index.js";
import { createReasoningTraceWidget } from "../widgets/run/reasoning_trace/index.js";
import { createDrilldownTableWidget } from "../widgets/run/drilldown_table/index.js";
import { createThreeRenderer } from "../widgets/three_renderer/index.js";
import { createForceGraph2DRenderer } from "../widgets/force_graph_2d/index.js";
import { mapManifestToDagData } from "../manifest_explorer/manifest-mapping.js";

// The visual workflow designer is an imperative widget instance (not Alpine
// reactive state). Kept module-scoped — one Bridge mounts per page — so Alpine
// never proxies it (proxying would rebind its methods and break pointer state).
let _designerWidget = null;
import { createBridgeContext, bridgeDeepLink } from "./bridge-context.js";

export const MODES = [
  { id: "pulse", label: "Pulse", icon: "monitoring" },
  { id: "memory", label: "Memory", icon: "bubble_chart" },
  { id: "documents", label: "Documents", icon: "description" },
  { id: "code", label: "Code 3D", icon: "account_tree" },
  { id: "flows", label: "Flows", icon: "alt_route" },
  { id: "studio", label: "Studio", icon: "science" },
  { id: "runs", label: "Runs", icon: "timeline" },
  { id: "v2", label: "Governance V2", icon: "policy" },
  { id: "v3", label: "Governance V3", icon: "scatter_plot" },
  { id: "agents", label: "Agents", icon: "smart_toy" }
];

// Mode-aware Benny suggestion chips. `instruction` is the human-facing intent;
// bridge-context appends the live mode/selection/workspace before dispatch.
export const CHIPS = {
  pulse: [
    {
      label: "Tour this project",
      instruction:
        "Give me a tour of this project: what Benny is, the workflows I have, and where to start. Load the project-guide skill."
    },
    {
      label: "What did I work on?",
      instruction:
        "Summarise what I worked on most recently across my agent sessions and git activity."
    },
    {
      label: "Is the mesh healthy?",
      instruction:
        "Check the integration conformance and tell me if anything has drifted, with the owner file to fix."
    }
  ],
  memory: [
    {
      label: "What did I work on?",
      instruction: "Summarise my most recent agent sessions and link the most relevant ones."
    },
    {
      label: "Sessions that touched a file…",
      instruction: "Find which sessions touched a file I name and link each one."
    }
  ],
  documents: [
    {
      label: "Ingest these docs",
      instruction:
        "Walk me through ingesting the documents in the current workspace into the knowledge graph as semantic triples."
    },
    {
      label: "What's in this workspace?",
      instruction: "Summarise the documents and concepts in the current workspace."
    },
    {
      label: "Query the docs",
      instruction: "Answer a question using the ingested documents in the current workspace."
    }
  ],
  code: [
    {
      label: "Explain this graph",
      instruction: "Explain the code graph I'm looking at and the role of the selected node."
    },
    {
      label: "What depends on this?",
      instruction: "Describe what depends on the selected code node and what it depends on."
    }
  ],
  flows: [
    {
      label: "Help me phrase a requirement",
      instruction: "Help me phrase a clear requirement for a pipeline I can then plan and run."
    },
    {
      label: "Re-run the last manifest",
      instruction: "Re-run the most recent manifest and report the outcome."
    }
  ],
  studio: [
    {
      label: "Draft a research question",
      instruction:
        "Help me phrase a sharp question I can ask the documents in this workspace from a Studio chat cell."
    },
    {
      label: "Outline a report",
      instruction:
        "Suggest a goal for a multi-step report I can run as a Studio report cell over this workspace."
    }
  ],
  runs: [
    {
      label: "Explain this run",
      instruction: "Explain what happened in the selected run, step by step."
    },
    {
      label: "Why did it fail?",
      instruction: "If the selected run failed, diagnose the likely cause from its lineage."
    }
  ],
  v2: [
    {
      label: "Explain this run",
      instruction:
        "Explain the active run or session in the Governance V2 view: its status, risk weight, error count, and what each step did. Use the Bridge context to get the active run id, then call sessionDetail or runs() to fetch the full lineage."
    },
    {
      label: "Why is risk weight high?",
      instruction:
        "Explain why the active run has a high risk weight in the Governance Navigator and what I should do to reduce it. Use the Bridge context for the risk weight and error count."
    },
    {
      label: "Summarise the navigator",
      instruction:
        "Summarise what I'm seeing in the Governance Navigator: how many runs/sessions are visible, how many have failures, and what the current filter and sort settings mean for the view."
    },
    {
      label: "Trace lineage at this step",
      instruction:
        "Explain what happened at the selected node or step-through position in the lineage timeline. Use the Bridge context for the selected node ID (or step index) and active run id."
    }
  ],
  v3: [
    {
      label: "What is the V3 core?",
      instruction:
        "Explain what the Governance V3 core node represents and how the Policy, Estate, Rules and Agents branches relate to it. Use the Bridge context for the current V3 state (0 = core, 1 = branches exploded, 2 = details)."
    },
    {
      label: "Explain this branch",
      instruction:
        "Explain the governance branch currently focused in the Governance V3 blueprint (Policy, Estate, Rules or Agents): what it governs, where its data comes from, and what would make it fail. Use the Bridge context for the active branch and workspace."
    },
    {
      label: "Policy vs rules — what differs?",
      instruction:
        "Explain the difference between the Policy and Rules branches in Governance V3 for this workspace, and which one decides whether a run is allowed to proceed."
    },
    {
      label: "Estate health from here",
      instruction:
        "Summarise estate health as the Governance V3 Estate branch sees it: which machines and workspaces are registered, what is stale, and what needs attention. Use the Bridge context for the active workspace."
    }
  ],
  agents: [
    {
      label: "Which model runs synthesis?",
      instruction:
        "Tell me which model is currently resolved for graph_synthesis in this workspace and whether it's local."
    },
    {
      label: "Recommend a local setup",
      instruction:
        "Recommend which local models to assign to chat and graph_synthesis given my running providers."
    }
  ]
};

// File types Benny's ingestion pipeline accepts for upload (mirrors the
// runtime's /api/files/upload allow-list). Drag-drop and the picker filter to
// these before sending so the operator gets an immediate, honest rejection.
export const UPLOAD_EXTENSIONS = [".pdf", ".txt", ".md", ".json"];

/* ── pure helpers (unit-tested) ──────────────────────────────────────── */

// Map the runtime indexing-manifest status onto an operator-facing label.
// ALIGNED  = the file's chunks are present in the knowledge graph (ingested).
// MISSING  = on disk but not yet ingested.
// STAGED   = present in data_in but outside the indexing manifest (e.g. an
//            unsupported type, or freshly uploaded before the next rescan).
export function fileStatusLabel(status) {
  switch (status) {
    case "ALIGNED":
      return "Ingested";
    case "MISSING":
      return "Not ingested";
    case "STAGED":
      return "Staged";
    default:
      return status || "Unknown";
  }
}

export function fileStatusClass(status) {
  switch (status) {
    case "ALIGNED":
      return "is-ingested";
    case "MISSING":
      return "is-pending";
    default:
      return "is-staged";
  }
}

// Merge the data_in listing with the indexing manifest into one rows array the
// Documents view renders. Pure so the merge logic is unit-testable without a
// runtime. `dataIn` entries may be strings or {name} objects.
export function mergeFileStatus(dataIn, manifest) {
  const rows = Array.isArray(dataIn) ? dataIn : [];
  const byName = new Map();
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    if (entry && entry.name) byName.set(entry.name, entry);
  }
  return rows.map((f) => {
    const name = typeof f === "string" ? f : (f && f.name) || "";
    const m = byName.get(name);
    if (m) {
      return { name, status: m.status || "MISSING", chunks: m.chunks || 0, type: m.type || "" };
    }
    return { name, status: "STAGED", chunks: 0, type: "" };
  });
}

// Map a stored workflow ({nodes:[{id,type,data:{label}}], edges:[{source,target}]})
// to the dag.canvas {nodes:[{id,label,kind}], edges:[{source,target}]} contract.
// dag.canvas auto-lays-out from edges (layered topological), so node positions
// in the stored definition are ignored for rendering.
export function workflowToDag(wf) {
  const w = wf || {};
  return {
    nodes: (Array.isArray(w.nodes) ? w.nodes : []).map((n) => ({
      id: n.id,
      label: (n.data && n.data.label) || n.label || n.id,
      kind: n.type || "node"
    })),
    edges: (Array.isArray(w.edges) ? w.edges : []).map((e) => ({
      source: e.source,
      target: e.target,
      label: e.label
    }))
  };
}

export function readQuery(hash) {
  const out = { mode: "", id: "", workspace: "" };
  try {
    const h =
      typeof hash === "string"
        ? hash
        : typeof window !== "undefined" && window.location
          ? window.location.hash
          : "";
    const qi = h.indexOf("?");
    if (qi < 0) return out;
    const params = new URLSearchParams(h.slice(qi + 1));
    out.mode = params.get("mode") || "";
    out.id = params.get("id") || "";
    out.workspace = params.get("workspace") || "";
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
    case "commit":
      return "commit";
    case "artifact":
      return "draft";
    case "session":
      return "forum";
    default:
      return "circle";
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
    lastId: last ? last.run_id || last.id || "" : "",
    lastStatus: last ? last.status || "" : ""
  };
}

// A run is "done" (stop live-polling) once it reaches any terminal status.
export function isTerminalStatus(status) {
  return [
    "completed",
    "complete",
    "succeeded",
    "success",
    "failed",
    "failure",
    "error",
    "errored",
    "cancelled",
    "canceled"
  ].includes(String(status || "").toLowerCase());
}

// Human-readable duration from milliseconds.
export function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

/* ── page factory ────────────────────────────────────────────────────── */

export function createBridgePage(options = {}) {
  const injected = options || {};
  return {
    modes: MODES,
    mode: "pulse",
    zen: false,
    error: "",
    v2Layout: true, // Show the new HUD layout by default

    // App-wide run activity (activity-store.js): one SSE/poll subscription
    // shared by every screen; drives the header activity chip.
    activity: { transport: "connecting", runs: [], running: 0, failures: 0 },
    _activityUnsub: null,
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
    outputs: [], // generated deliverables in data_out (read-only, recursive)
    // LONGVIEW pipeline (ADR-005) — launch + live heartbeat for the longview
    // workspace. Truth comes from /api/longview_status (runner lock + the
    // runner's own status.json), so it reflects CLI/tray launches too.
    longview: { running: false, heartbeat: null, busy: false, error: "", lastLog: "" },
    _longviewTimer: null,
    selectedFiles: [], // names of files the operator picked to ingest
    ingesting: false,
    ingestNote: "",
    dragOver: false,
    uploading: false,
    rescanning: false,
    visionIngest: false,
    visionSummary: "",

    // wizard
    wizardActive: false,
    wizardWorkflow: "",
    wizardCliRunning: false,
    wizardCliVisible: false,
    wizardCliStatus: "",
    wizardCliOutput: "",

    // documents — ask (RAG chat over the ingested docs)
    docQuestion: "",
    docAnswer: "",
    docSources: [],
    docRoute: "",
    docTrace: [],
    agentMode: true,
    asking: false,
    docs3d: false,
    // "fluid" = organic force-simulated motion (the Memo-Ray look, default);
    // "pinned" freezes nodes at their layered layout positions.
    docsPhysics: "fluid",
    docsFocusLayer: 0, // 0 = all AoT layers, 1..5 = focus a single layer
    // Knowledge-graph view mode:
    //   "connected" — all documents + every connected concept (orphans hidden)
    //   "all"       — the above + orphan concepts (isolated dust; lite renderer)
    //   "macro"     — document super-nodes; click one to expand its concepts
    docsGraphMode: "connected",
    docsSourceId: null, // when set (macro drill-down), the expanded document

    // code
    code3d: false,
    codePhysics: "fluid",
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

    // flows — workflow library (manage/view/update templates + saved)
    workflows: [],
    workflowsLoading: false,
    selectedWorkflowId: "",
    selectedWorkflow: null,
    workflowDraft: "", // JSON of the selected workflow being edited
    workflowEditing: false, // toggles the raw JSON editor
    designerOn: false, // toggles the visual node designer
    designerNode: null, // { id, label, type } of the selected node (config form)
    workflowSaving: false,
    workflowNote: "",

    // flows — deep produce (orchestrated fan-out → multi-panel view)
    dpGoal: "",
    dpPanels: 4,
    dpRunId: "",
    dpStatus: "", // '' | running | completed | failed
    dpView: null,
    dpNote: "",
    _dpPollTimer: null,

    // studio (notebook — cells unify "ask the docs" + "deep produce")
    studioCells: [],
    _studioSeq: 0,

    // runs (observability)
    runs: [],
    activeRunId: "",
    runDetail: null, // /manifests/runs/{run_id} — node_states, errors, timings
    activeStepId: "", // step drilled into (drilldown_table)
    livePoll: true, // auto-refresh while a run is in-flight
    _livePollTimer: null,
    _runTimeline: null, // widget handles kept for live refresh()
    _runTrace: null,
    _obsTimeline: null,
    _obsTrace: null,
    _drillWidget: null,

    // governance v2 (weighted metrics, recency, step-through focus)
    govSort: "weight", // 'weight' | 'time' | 'duration' | 'errors'
    govFilter: "all", // 'all' | 'failures' | 'compliant'
    govStepIndex: 0,
    govSelectedNode: null,

    // agents (model + provider routing — single config surface)
    agentProviders: {}, // raw /llm/status
    agentConfig: null, // /llm/config (default_model, model_roles, resolved)
    agentModelOptions: [], // [{ value:"lmstudio/<id>", label, provider, running }]
    agentRoles: [],
    agentSaving: false,
    agentNote: "",

    // multi-pane (split view) — a secondary Observe pane beside the stage
    splitView: false, // operator opt-in; only honoured when `wide`
    wide: false, // viewport ≥ 1600px

    _ctx: null,
    _widgets: [],
    _widgets2: [], // secondary-pane widgets — tracked + destroyed apart
    _onResize: null,
    _codeWidget: null,
    _docsWidget: null,

    async init() {
      this._ctx = injected.context || createBridgeContext({ agent: injected.agent });
      const q = readQuery();
      if (q.id) this.selection = { id: q.id };
      if (q.workspace) this.workspace = q.workspace;
      const initialMode = isValidMode(q.mode) ? q.mode : await this.resolveDefaultMode();
      this.loadConformance();
      this.loadWorkspaces();
      this._activityUnsub = subscribeActivity((snap) => {
        this.activity = snap;
      });
      await this.setMode(initialMode);
      this.initAnime();
      this.initV3();
      this._setupViewport();
    },

    v3State: 0,
    v3Dots: Array.from({ length: 15 }, (_, i) => i),
    
    initV3() {
      if (!window.anime) return;
      this.$watch('mode', (m) => {
        if (m === 'v3') {
          this.$nextTick(() => {
            window.anime({
              targets: '.v3-dot',
              scale: [0, 1],
              opacity: [0, 1],
              delay: window.anime.stagger(50, {grid: [5, 3], from: 'center'}),
              easing: 'easeOutBack',
              duration: 800
            });
            this.updateV3State(0, true);
          });
        }
      });
    },

    updateV3State(newState, force = false) {
      if (!window.anime) return;
      if (newState < 0) newState = 0;
      if (newState > 2) newState = 2;
      if (this.v3State === newState && !force) return;
      
      this.v3State = newState;

      if (newState === 0) {
        window.anime({
          targets: '.v3-sub-node',
          translateX: 0,
          translateY: 0,
          scale: 0,
          opacity: 0,
          easing: 'easeInExpo',
          duration: 600
        });
        window.anime({
          targets: '.v3-central',
          scale: 1,
          opacity: 1,
          duration: 800
        });
        window.anime({
          targets: '.v3-details-panel',
          opacity: 0,
          scale: 0.9,
          duration: 300
        });
      } else if (newState === 1) {
        window.anime({
          targets: '.v3-central',
          scale: 0.5,
          opacity: 0.5,
          duration: 800,
          easing: 'easeOutExpo'
        });
        
        const subNodes = this.$el.querySelectorAll('.v3-sub-node');
        subNodes.forEach((node, i) => {
          window.anime({
            targets: node,
            translateX: node.getAttribute('data-x') || 0,
            translateY: node.getAttribute('data-y') || 0,
            scale: 1,
            opacity: 1,
            delay: i * 100,
            easing: 'easeOutElastic(1, .6)',
            duration: 1200
          });
        });
        
        window.anime({
          targets: '.v3-details-panel',
          opacity: 0,
          scale: 0.9,
          duration: 300
        });
      } else if (newState === 2) {
        window.anime({
          targets: '.v3-sub-node',
          scale: 0.8,
          opacity: 0.3,
          duration: 800
        });
        window.anime({
          targets: '.v3-details-panel',
          opacity: 1,
          scale: 1,
          easing: 'easeOutExpo',
          duration: 800
        });
      }
    },

    initAnime() {
      if (window.anime) {
        window.anime({
          targets: ".benny-anime-svg path, .benny-anime-svg ellipse, .benny-anime-svg circle",
          strokeDashoffset: [window.anime.setDashoffset, 0],
          easing: "easeInOutSine",
          duration: 1500,
          delay: function (el, i) {
            return i * 150;
          },
          direction: "alternate",
          loop: true
        });
      }
    },

    // Header activity chip → jump to the most relevant run in Runs mode:
    // newest active run, else newest failure, else just the runs list.
    async openActivity() {
      const runs = this.activity.runs || [];
      const target =
        runs.find((r) => ["pending", "planning", "running"].includes(r.status)) ||
        runs.find((r) => r.status === "failed") ||
        runs[0];
      await this.setMode("runs");
      if (target && typeof this.selectRun === "function") {
        await this.selectRun(target.runId);
      }
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

    // Navigable breadcrumb trail: Bridge › Mode › Workspace › Selection.
    // The workspace crumb only appears for modes the workspace actually scopes
    // (matches the stage-bar's x-show set); the selection crumb only when the
    // operator has drilled into a session / run / document / graph node. The
    // last crumb is the current location (aria-current, not clickable).
    get crumbs() {
      const wsScoped = ["documents", "code", "flows", "studio", "runs"].includes(this.mode);
      const trail = [{ level: "root", label: "Bridge" }];
      trail.push({ level: "mode", label: this.activeModeLabel });
      if (wsScoped) trail.push({ level: "workspace", label: this.workspace });
      const sel = this.selection && (this.selection.label || this.selection.id);
      if (sel) trail.push({ level: "selection", label: sel });
      return trail.map((c, i) => ({ ...c, current: i === trail.length - 1 }));
    },

    // Click an ancestor crumb to navigate "up": root → home (Pulse); mode or
    // workspace → drop the deeper selection but stay in the current mode. The
    // current (last) crumb is a no-op.
    goCrumb(crumb) {
      if (!crumb || crumb.current) return;
      if (crumb.level === "root") {
        this.setMode("pulse");
        return;
      }
      // mode / workspace → clear the active selection and re-render the stage.
      this.clearSelection();
    },

    // Drop the active drill-in (selection + per-mode active ids) and re-mount
    // the current stage so the graph clears its highlight / detail panes.
    clearSelection() {
      this.selection = null;
      this.activeSessionId = "";
      this.activeStepId = "";
      this.syncContext();
      this.$nextTick(() => this.mountStage());
    },

    // The secondary pane is live only when the operator opted in AND the
    // viewport is wide enough to carry two panes without crushing either.
    get splitActive() {
      return this.splitView && this.wide;
    },

    // Run metrics distilled from the RunRecord (real fields only — status,
    // timing, per-step states, errors). No fabricated cost/token numbers.
    get runMetrics() {
      const r =
        this.runDetail || this.runs.find((x) => (x.run_id || x.id) === this.activeRunId) || {};
      const states = r.node_states || {};
      const stepIds = Object.keys(states);
      const failed = stepIds.filter((id) => /fail|error/i.test(String(states[id]))).length;
      let dur = r.duration_ms;
      if (dur == null && r.started_at && r.completed_at) {
        const a = Date.parse(r.started_at);
        const b = Date.parse(r.completed_at);
        if (!Number.isNaN(a) && !Number.isNaN(b)) dur = b - a;
      }
      return {
        status: r.status || "—",
        duration: dur != null ? fmtDuration(dur) : "—",
        steps: stepIds.length,
        failed,
        errors: Array.isArray(r.errors) ? r.errors.length : 0,
        inflight: !!this.activeRunId && !isTerminalStatus(r.status)
      };
    },

    get runStepRows() {
      const states = (this.runDetail && this.runDetail.node_states) || {};
      return Object.keys(states).map((id) => ({ id, status: states[id] }));
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
          v2Layout: this.v2Layout,
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
        case "pulse":
          return this.mountPulse();
        case "memory":
          return this.mountMemory();
        case "documents":
          return this.mountDocuments();
        case "code":
          return this.mountCode();
        case "flows":
          return this.mountFlows();
        case "studio":
          return this.mountStudio();
        case "runs":
          return this.mountRuns();
        case "v2":
          return this.mountV2();
        case "agents":
          return this.mountAgents();
        default:
          return undefined;
      }
    },

    get sortedGovRuns() {
      const rawRuns = (this.runs || []).map((r) => ({ ...r, type: "run" }));
      const rawSessions = (this.sessions || []).map((s) => ({
        id: s.id,
        run_id: s.id,
        status: "completed",
        started_at: s.created_at || s.timestamp || new Date().toISOString(),
        duration_ms: s.duration || 0,
        errors: [],
        node_states: {},
        type: "session",
        title: s.content || "Session"
      }));

      let raw = [...rawRuns, ...rawSessions];

      if (raw.length === 0) {
        raw = [
          {
            id: "run-cmr-v2-001",
            status: "completed",
            started_at: new Date(Date.now() - 300000).toISOString(),
            duration_ms: 14200,
            errors: [],
            node_states: { step1: "success", step2: "success", step3: "success" }
          },
          {
            id: "run-cmr-v2-002",
            status: "failed",
            started_at: new Date(Date.now() - 1200000).toISOString(),
            duration_ms: 65400,
            errors: ["Step 2 assertion failed"],
            node_states: { step1: "success", step2: "failed" }
          },
          {
            id: "run-cmr-v2-003",
            status: "completed",
            started_at: new Date(Date.now() - 3600000).toISOString(),
            duration_ms: 8100,
            errors: [],
            node_states: { step1: "success" }
          }
        ];
      }

      const scored = raw.map((r) => {
        const states = r.node_states || {};
        const stepIds = Object.keys(states);
        const errCount =
          (r.errors ? r.errors.length : 0) +
          stepIds.filter((id) => /fail|error/i.test(String(states[id]))).length;
        let weight = 15;
        if (errCount > 0) weight += errCount * 35;
        if (r.status === "failed") weight += 30;
        if (r.duration_ms > 40000) weight += 15;
        return {
          ...r,
          riskWeight: Math.min(100, weight),
          errCount,
          formattedDuration: r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + "s" : "N/A"
        };
      });

      let filtered = scored;
      if (this.govFilter === "failures") {
        filtered = scored.filter((r) => r.status === "failed" || r.errCount > 0);
      } else if (this.govFilter === "compliant") {
        filtered = scored.filter((r) => r.status === "completed" && r.errCount === 0);
      }

      return filtered.sort((a, b) => {
        if (this.govSort === "weight") return b.riskWeight - a.riskWeight;
        if (this.govSort === "time")
          return Date.parse(b.started_at || 0) - Date.parse(a.started_at || 0);
        if (this.govSort === "duration") return (b.duration_ms || 0) - (a.duration_ms || 0);
        if (this.govSort === "errors") return b.errCount - a.errCount;
        return 0;
      });
    },

    selectGovRun(runId) {
      this.activeRunId = runId;
      this.govStepIndex = 0;
      this.govSelectedNode = null;

      const sessionData = this.sessions.find((s) => s.id === runId);
      if (sessionData) {
        this.activeSessionId = runId;
      }

      this._syncGovContext();
      this.observeRun(runId).then(() => this.mountV2());
    },

    nextGovStep() {
      const v2Timeline = document.getElementById("v2-timeline");
      if (v2Timeline && typeof v2Timeline.stepPlayback === "function") {
        v2Timeline.stepPlayback(1);
        this.govStepIndex = Math.max(0, v2Timeline.playbackIndex || 0);
        this._syncGovContext();
      }
    },

    prevGovStep() {
      const v2Timeline = document.getElementById("v2-timeline");
      if (v2Timeline && typeof v2Timeline.stepPlayback === "function") {
        v2Timeline.stepPlayback(-1);
        this.govStepIndex = Math.max(0, v2Timeline.playbackIndex || 0);
        this._syncGovContext();
      }
    },

    /**
     * Compute the full Governance V2 snapshot and push it into bridge context.
     * Called after every user interaction that changes the governance view state:
     * selecting a run, navigating steps, changing filter/sort. This ensures that
     * when the operator asks Benny a chip question, the context already reflects
     * exactly what they see — active run, risk score, step cursor, filter, sidebar.
     */
    _syncGovContext() {
      if (!this._ctx) return;

      const runId = this.activeRunId;
      const isSession = !!this.sessions.find((s) => s.id === runId);
      const scored = this.sortedGovRuns; // computed getter — already filtered + sorted

      // Find the scored entry for the active run so we get risk metrics.
      const active = runId ? scored.find((r) => (r.run_id || r.id) === runId) : null;

      // Build a summary of node_states for pipeline runs (from runDetail).
      let nodeStatesSummary = null;
      if (this.runDetail && this.runDetail.node_states) {
        const states = this.runDetail.node_states;
        const counts = {};
        for (const v of Object.values(states)) {
          const key = String(v).toLowerCase();
          counts[key] = (counts[key] || 0) + 1;
        }
        nodeStatesSummary = Object.entries(counts)
          .map(([k, n]) => `${n} ${k}`)
          .join(", ");
      }

      // Step total from the timeline component (best-effort).
      let stepTotal = null;
      try {
        const tl = typeof document !== "undefined" && document.getElementById("v2-timeline");
        if (tl) stepTotal = tl.totalSteps ?? tl.nodeCount ?? null;
      } catch {
        /* DOM not available in tests */
      }

      const totalVisible = scored.length;
      const totalFailures = scored.filter((r) => r.status === "failed" || r.errCount > 0).length;

      this.syncContext({
        pageContext: {
          governance: {
            // Active run / session
            activeRunId: runId || null,
            activeType: runId ? (isSession ? "session" : "run") : null,
            activeStatus: active?.status || null,
            activeRiskWeight: active?.riskWeight ?? null,
            activeErrCount: active?.errCount ?? null,
            activeDuration: active?.formattedDuration || null,
            activeTitle: active?.title || null, // sessions have titles
            // Step-through cursor & node selection
            stepIndex: this.govStepIndex,
            stepTotal,
            selectedNodeId: this.govSelectedNode?.id || null,
            selectedNodeLabel: this.govSelectedNode?.label || null,
            selectedNodeLane: this.govSelectedNode?.swimlaneId || null,
            // Navigator state
            filter: this.govFilter,
            sort: this.govSort,
            // Sidebar summary
            summary: {
              totalVisible,
              totalFailures,
              filter: this.govFilter,
              sort: this.govSort
            },
            // Per-step node_states (pipeline runs only)
            nodeStatesSummary
          }
        }
      });
    },

    /**
     * Translate a memoray graph entity type to a lineage-timeline swimlane id.
     * Session → sessions, User Input/Prompt/Thought/Message → chats,
     * Tool Call/Result → tools, Artifact/File → outputs,
     * anything else → logs.
     */
    _swimlaneFor(entityType) {
      if (!entityType) return "logs";
      const t = String(entityType).trim().toLowerCase();
      if (t === "session" || t === "run" || t === "workflow") return "sessions";
      if (
        t.includes("user") ||
        t.includes("input") ||
        t.includes("prompt") ||
        t === "thought" ||
        t === "message" ||
        t === "chat" ||
        t === "conversation" ||
        t === "assistant" ||
        t === "query"
      )
        return "chats";
      if (t.includes("tool") || t === "job" || t === "action" || t === "step") return "tools";
      if (
        t === "artifact" ||
        t === "file" ||
        t === "data out" ||
        t === "output" ||
        t === "document" ||
        t === "commit"
      )
        return "outputs";
      if (t === "context" || t === "data in") return "inputs";
      return "logs";
    },

    /**
     * Convert a memoray /api/graph/:id response ({nodes, links}) into the
     * {sessionId, timeRange, nodes, edges} payload the <lineage-timeline>
     * web component expects. Uses real entity timestamps and the actual
     * parent→child links so the timeline renders the true session trace.
     */
    _graphToTimelineData(graph, sessionId) {
      if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return null;

      // Sort by real timestamp so timeline ordering is chronological.
      const sorted = [...graph.nodes].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      const nodes = sorted.map((n) => {
        const swimlaneId = this._swimlaneFor(n.type);
        let label = n.label || n.type || "Node";
        if (swimlaneId === "chats" && n.content) {
          const clean = String(n.content)
            .replace(/<[^>]+>/g, "")
            .trim();
          if (clean) {
            label = clean.length > 35 ? clean.substring(0, 35) + "..." : clean;
          }
        }
        return {
          id: n.id,
          swimlaneId,
          timestamp: n.timestamp || Date.now(),
          label,
          type: n.type || "unknown",
          metadata: {
            agent: n.agent || "",
            content: (n.content || "").substring(0, 500),
            toolName: n.metadata?.toolName || "",
            fileName: n.metadata?.fileName || "",
            filePath: n.metadata?.filePath || "",
            isVirtual: n.metadata?.isVirtual || false
          }
        };
      });

      // Translate parent→child links. The memoray graph uses { source, target }
      // where source/target are entity id strings. The timeline uses { from, to }.
      const nodeIds = new Set(nodes.map((n) => n.id));
      const edges = (graph.links || [])
        .map((l) => ({
          from: typeof l.source === "object" ? l.source.id : l.source,
          to: typeof l.target === "object" ? l.target.id : l.target
        }))
        .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

      const timestamps = nodes.map((n) => n.timestamp).filter((t) => t > 0);
      const start = timestamps.length ? Math.min(...timestamps) : Date.now();
      const end = timestamps.length ? Math.max(...timestamps) : start + 1000;

      return {
        sessionId,
        timeRange: { start, end: start === end ? end + 1000 : end },
        nodes,
        edges
      };
    },

    async mountV2() {
      if (!this.runs || this.runs.length === 0) {
        await this.loadRuns();
      }
      if (!this.sessions || this.sessions.length === 0) {
        await this.loadSessions();
      }

      // Publish governance context to Benny now that runs + sessions are loaded.
      // This fires once on mount so chip questions work even before the operator
      // clicks a specific run.
      this._syncGovContext();

      const v2Timeline = document.getElementById("v2-timeline");
      if (!v2Timeline || typeof v2Timeline.setData !== "function") return;

      if (!v2Timeline._hasNodeSelectedListener) {
        v2Timeline._hasNodeSelectedListener = true;
        v2Timeline.addEventListener("node-selected", (e) => {
          const detail = e.detail || {};
          if (detail.stepIndex != null && detail.stepIndex >= 0) {
            this.govStepIndex = detail.stepIndex;
          }
          if (detail.nodeId) {
            this.govSelectedNode = {
              id: detail.nodeId,
              label: detail.node?.label || detail.nodeId,
              swimlaneId: detail.node?.swimlaneId || null,
              type: detail.node?.type || null
            };
            this.selection = {
              id: detail.nodeId,
              label: detail.node?.label || detail.nodeId,
              type: "node",
              mode: "v2"
            };
          }
          this._syncGovContext();
        });
      }

      let data = null;

      try {
        if (this.activeRunId) {
          // Check whether the selected item is a memoray session or a pipeline run.
          const isSession = this.sessions.some((s) => s.id === this.activeRunId);

          if (isSession) {
            // Fetch the real session graph from memoray.
            // memorayFetch prepends /api/memoray, so pass the server path only.
            const resp = await memorayFetch("/graph/" + this.activeRunId);
            const graph = await readMemorayJson(resp);
            data = this._graphToTimelineData(graph, this.activeRunId);
          } else {
            // Pipeline run — try the governance events endpoint.
            const resp = await runtimeFetch(
              `/governance/events?workspace=${encodeURIComponent(this.workspace || "default")}&run_id=${encodeURIComponent(this.activeRunId)}&limit=200`
            );
            const payload = await readRuntimeJson(resp);
            const events = payload && Array.isArray(payload.events) ? payload.events : [];
            if (events.length > 0) {
              const nodes = events.map((ev, i) => {
                const d = ev.data || {};
                const details = d.details || {};
                const skill = d.skill || details.skill || "";
                let lane = "tools";
                if (ev.event_type === "AGENT_AUTHORSHIP") lane = "chats";
                else if (/read|view|fetch|context/i.test(skill)) lane = "inputs";
                else if (/write|replace|create/i.test(skill)) lane = "outputs";
                else if (/log|error|warn/i.test(ev.event_type)) lane = "logs";
                return {
                  id: ev._integrity_hash || `evt_${i}`,
                  swimlaneId: lane,
                  timestamp: ev.timestamp
                    ? new Date(ev.timestamp).getTime()
                    : Date.now() + i * 1000,
                  label: ev.event_type + (skill ? " — " + skill : ""),
                  type: ev.event_type || "event",
                  metadata: { skill, process: d.process || "", outcome: d.outcome || "" }
                };
              });
              // Chain events sequentially since governance events are a flat log.
              const edges = [];
              for (let i = 0; i < nodes.length - 1; i++) {
                edges.push({ from: nodes[i].id, to: nodes[i + 1].id });
              }
              const ts = nodes.map((n) => n.timestamp);
              const start = Math.min(...ts);
              const end = Math.max(...ts);
              data = {
                sessionId: this.activeRunId,
                timeRange: { start, end: start === end ? end + 1000 : end },
                nodes,
                edges
              };
            }
          }
        }
      } catch (err) {
        console.warn("Gov V2: dynamic timeline data unavailable, falling back to mock.", err);
      }

      if (data) {
        v2Timeline.setData(data);
      } else {
        // Fallback to the static demo dataset so the component never shows blank.
        try {
          const r = await fetch("/mod/_core/visual/timeline/dataset.json");
          const mock = await r.json();
          if (this.activeRunId) {
            mock.sessionId = this.activeRunId;
            const root = mock.nodes.find((n) => n.id === "run_main");
            if (root) root.label = "Run: " + this.activeRunId.slice(0, 8);
          }
          v2Timeline.setData(mock);
        } catch (e) {
          console.log("Mock V2 data not found", e);
        }
      }
    },

    track(widget) {
      if (widget && typeof widget.destroy === "function") this._widgets.push(widget);
      return widget;
    },

    destroyWidgets() {
      for (const w of this._widgets) {
        try {
          w.destroy();
        } catch {
          /* swallow */
        }
      }
      this._widgets = [];
      this._codeWidget = null;
      this._docsWidget = null;
      this._runTimeline = null;
      this._runTrace = null;
      if (this._drillWidget) {
        try {
          this._drillWidget.destroy();
        } catch {
          /* swallow */
        }
        this._drillWidget = null;
      }
    },

    /* ── multi-pane (split view) ──────────────────────────────────────────
       The primary pane is the active mode; the secondary "Observe" pane shows
       a run's lineage timeline + reasoning trace beside it. Its widgets live in
       a separate list (_widgets2) and mount into their own ref hosts so a mode
       switch (which calls destroyWidgets) never tears the Observe pane down. */

    _setupViewport() {
      const apply = () => {
        const wide = typeof window !== "undefined" && window.innerWidth >= 1600;
        if (wide === this.wide) return;
        this.wide = wide;
        // Crossing the threshold mounts/tears down the secondary so its
        // widgets exist only while the pane is actually on screen.
        if (this.splitView) {
          if (this.splitActive) this.mountSecondary();
          else this.destroySecondary();
        }
      };
      this._onResize = apply;
      if (typeof window !== "undefined") window.addEventListener("resize", apply);
      apply();
    },

    track2(widget) {
      if (widget && typeof widget.destroy === "function") this._widgets2.push(widget);
      return widget;
    },

    destroySecondary() {
      for (const w of this._widgets2) {
        try {
          w.destroy();
        } catch {
          /* swallow */
        }
      }
      this._widgets2 = [];
      this._obsTimeline = null;
      this._obsTrace = null;
    },

    async toggleSplit() {
      this.splitView = !this.splitView;
      this.syncContext();
      await this.$nextTick();
      if (this.splitActive) this.mountSecondary();
      else this.destroySecondary();
    },

    async mountSecondary() {
      if (!this.splitActive) return;
      this.destroySecondary();
      if (!this.runs.length) await this.loadRuns();
      if (!this.activeRunId && this.runs.length) {
        this.activeRunId = this.runs[0].run_id || this.runs[0].id || "";
      }
      await this.loadRunDetail(this.activeRunId);
      await this.$nextTick();
      const timeline = this.$refs.obsTimeline;
      const trace = this.$refs.obsTrace;
      if (timeline && this.activeRunId) {
        this._obsTimeline = this.track2(
          createLineageTimelineWidget(timeline, {
            workspace: this.workspace,
            run_id: this.activeRunId
          })
        );
      }
      if (trace && this.activeRunId) {
        this._obsTrace = this.track2(
          createReasoningTraceWidget(trace, { workspace: this.workspace, run_id: this.activeRunId })
        );
      }
      this.startRunPoll();
    },

    // Secondary-only run selection — never touches the primary pane's widgets.
    async observeRun(runId) {
      this.activeRunId = runId;
      this.syncContext();
      await this.loadRunDetail(runId);
      if (this.splitActive) this.mountSecondary();
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
        this.track(
          createOverviewCardsWidget(host, {
            onSelectSession: (id) => {
              this.activeSessionId = id;
              this.setMode("memory");
            }
          })
        );
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
        this.lifelogState = isMemorayDisabled(err)
          ? "disabled"
          : isMemorayOffline(err)
            ? "offline"
            : "error";
      }
    },

    lifelogIcon(type) {
      return lifelogIconFor(type);
    },
    ago(ts) {
      return relativeTime(ts);
    },

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
      // Push the selected session's metadata into bridge context so Benny
      // knows which session is in focus — not just its id — without having
      // to re-fetch the full session list on every chip dispatch.
      const sess = this.sessions.find((s) => s.id === id);
      if (sess) {
        this.syncContext({
          pageContext: {
            selectedSession: {
              id: sess.id,
              title: sess.content || "Untitled",
              agent: sess.agent || null,
              project: sess.metadata?.project || null,
              timestamp: sess.timestamp || null
            }
          }
        });
      }
      this.mountSessionGraph(id);
    },

    sessionTitle(id) {
      const s = this.sessions.find((x) => x.id === id);
      return s ? s.content || "Untitled" : id;
    },

    mountSessionGraph(sessionId) {
      const host = this.$refs.memoryGraph;
      if (!host) return;
      this.destroyWidgets();
      this.track(
        createLineageGraphWidget(
          host,
          {
            sessionId,
            onSelect: (nodeId) => this.onNodeSelect(nodeId)
          },
          // Living organic 2D graph by default (the Memo-Ray look), offline.
          { renderer: this.makeForceRenderer() }
        )
      );
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
      this._docsWidget = this.track(
        createSynopticWebWidget(
          host,
          {
            workspace: this.workspace,
            focusedLayer: this.docsFocusLayer || undefined,
            mode: this.docsGraphMode,
            sourceId: this.docsSourceId || undefined,
            onSelect: (id) => this.onDocsNodeSelect(id)
          },
          {
            renderer: this.docs3d
              ? this.makeThreeRenderer(this.docsPhysics)
              : this.makeForceRenderer(this.docsPhysics)
          }
        )
      );
    },

    // Switch the knowledge-graph view. Leaving macro clears any drill-down so we
    // don't stay pinned to a single expanded document.
    setDocsGraphMode(mode) {
      if (this.docsGraphMode === mode && !this.docsSourceId) return;
      this.docsGraphMode = mode;
      this.docsSourceId = null;
      this.mountKnowledgeGraph();
    },

    // In macro mode a click on a document super-node drills into that document's
    // concepts; elsewhere a click is a normal node selection.
    onDocsNodeSelect(id) {
      if (this.docsGraphMode === "macro" && !this.docsSourceId) {
        this.docsSourceId = id;
        this.mountKnowledgeGraph();
        return;
      }
      this.onNodeSelect(id);
    },

    // Back out of a macro drill-down to the 61-document overview.
    clearDocsDrilldown() {
      if (!this.docsSourceId) return;
      this.docsSourceId = null;
      this.mountKnowledgeGraph();
    },

    toggleDocs3d() {
      this.docs3d = !this.docs3d;
      this.mountKnowledgeGraph();
    },

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

    // List the workspace's staged files and reconcile them against the
    // knowledge-graph indexing manifest so each row carries its ingestion
    // status (Ingested / Not ingested / Staged) and chunk count.
    async loadFiles() {
      try {
        const [filesBody, manifest] = await Promise.all([
          readRuntimeJson(
            await runtimeFetch(`/files?workspace=${encodeURIComponent(this.workspace)}`)
          ),
          this.loadIndexingManifest()
        ]);
        const dataIn = filesBody && Array.isArray(filesBody.data_in) ? filesBody.data_in : [];
        const staging = filesBody && Array.isArray(filesBody.staging) ? filesBody.staging : [];
        const allFiles = [...staging, ...dataIn];
        this.files = mergeFileStatus(allFiles, manifest);
        // Generated deliverables (reports, skills, dossiers…) — data_out is
        // listed recursively by the runtime, so nested trees show up here.
        this.outputs = filesBody && Array.isArray(filesBody.data_out) ? filesBody.data_out : [];
        this.reconcileSelection();
        if (this.workspace === "longview") this.loadLongviewStatus();
      } catch {
        this.files = [];
        this.outputs = [];
        this.selectedFiles = [];
      }
    },

    // ── LONGVIEW launch + observability (ADR-005) ──
    async loadLongviewStatus() {
      try {
        const res = await fetch("/api/longview_status", { credentials: "same-origin" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const s = await res.json();
        const wasRunning = this.longview.running;
        this.longview.running = Boolean(s.running);
        this.longview.heartbeat = s.heartbeat || null;
        this.longview.lastLog = (s.log_tail && s.log_tail[s.log_tail.length - 1]) || "";
        this.longview.error = "";
        if (this.longview.running) {
          this.startLongviewPolling();
        } else if (wasRunning) {
          // A run just finished — outputs and graph likely changed.
          this.stopLongviewPolling();
          this.loadFiles();
        } else {
          this.stopLongviewPolling();
        }
      } catch (e) {
        this.longview.error = String(e.message || e);
        this.stopLongviewPolling();
      }
    },

    startLongviewPolling() {
      if (this._longviewTimer) return;
      this._longviewTimer = setInterval(() => this.loadLongviewStatus(), 8000);
    },

    stopLongviewPolling() {
      if (this._longviewTimer) {
        clearInterval(this._longviewTimer);
        this._longviewTimer = null;
      }
    },

    async runLongview(mode) {
      this.longview.busy = true;
      try {
        const res = await fetch("/api/longview_run", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode })
        });
        const body = await res.json().catch(() => ({}));
        this.longview.error = res.ok ? "" : body.error || `run ${res.status}`;
      } catch (e) {
        this.longview.error = String(e.message || e);
      } finally {
        this.longview.busy = false;
        await this.loadLongviewStatus();
      }
    },

    async stopLongview() {
      this.longview.busy = true;
      try {
        await fetch("/api/longview_stop", { method: "POST", credentials: "same-origin" });
      } catch {
        /* status poll below reports the truth */
      } finally {
        this.longview.busy = false;
        await this.loadLongviewStatus();
      }
    },

    longviewSummary() {
      const h = this.longview.heartbeat;
      if (!h) return this.longview.running ? "starting…" : "idle";
      const parts = [`phase ${h.phase || "?"}`];
      if (h.cards_ok != null && h.backlog_total != null)
        parts.push(`${h.cards_ok}/${h.backlog_total} cards`);
      if (h.map_failed) parts.push(`${h.map_failed} failed`);
      if (h.eta_hours_remaining != null && this.longview.running)
        parts.push(`~${h.eta_hours_remaining}h left`);
      return parts.join(" · ");
    },

    // Serve an output through the runtime's workspace static mount (proxied):
    // /api/runtime/static/<ws>/data_out/<relative path>.
    outputHref(f) {
      const rel = String((f && f.name) || "")
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      return `/api/runtime/static/${encodeURIComponent(this.workspace)}/data_out/${rel}`;
    },

    // ── Benny Record (ADR-005): map an output file to the record scope that
    // explains it, and open the player. Dossiers and book artifacts have their
    // own scopes; everything else falls back to the whole run. Only the longview
    // workspace produces records, so the ▶ Record affordance is gated on it.
    recordScope(f) {
      const name = String((f && f.name) || "");
      const dossier = name.match(/dossiers[\\/]([^\\/]+)\.md$/i);
      if (dossier) return `dossier:${dossier[1]}`;
      if (/(^|[\\/])opus[\\/]/i.test(name) || /\.pdf$/i.test(name)) return "book";
      return "run";
    },

    hasRecord() {
      return this.workspace === "longview" || this.workspace === "longview_v2";
    },

    openRecord(scope, { live = false } = {}) {
      const p = new URLSearchParams({ scope: scope || "run" });
      if (this.workspace) p.set("workspace", this.workspace);
      if (live) p.set("live", "1");
      window.location.hash = `#/_prime_silo/benny_record?${p.toString()}`;
    },

    // Keep the selection in sync with what's actually staged: drop names that
    // disappeared, and default-select anything still awaiting ingestion so the
    // common case (ingest the doc I just added) is one click. Already-ingested
    // (ALIGNED) files stay unchecked — re-ingest is opt-in.
    reconcileSelection() {
      const names = new Set(this.files.map((f) => f.name));
      const keep = this.selectedFiles.filter((n) => names.has(n));
      const keepSet = new Set(keep);
      for (const f of this.files) {
        if (f.status !== "ALIGNED" && !keepSet.has(f.name)) {
          keep.push(f.name);
          keepSet.add(f.name);
        }
      }
      this.selectedFiles = keep;
    },

    isSelected(name) {
      return this.selectedFiles.includes(name);
    },

    toggleFile(name) {
      const i = this.selectedFiles.indexOf(name);
      if (i === -1) this.selectedFiles.push(name);
      else this.selectedFiles.splice(i, 1);
    },

    selectAllFiles() {
      this.selectedFiles = this.files.map((f) => f.name);
    },
    clearFileSelection() {
      this.selectedFiles = [];
    },

    async loadIndexingManifest() {
      try {
        const body = await readRuntimeJson(
          await runtimeFetch(
            `/rag/indexing-manifest?workspace=${encodeURIComponent(this.workspace)}`
          )
        );
        return body && Array.isArray(body.manifest) ? body.manifest : [];
      } catch {
        return [];
      }
    },

    statusLabel(status) {
      return fileStatusLabel(status);
    },
    statusClass(status) {
      return fileStatusClass(status);
    },

    get pendingCount() {
      return this.files.filter((f) => f.status !== "ALIGNED").length;
    },

    /* ── drag-drop + upload (correct Benny ingestion path) ── */

    onDragOver() {
      this.dragOver = true;
    },
    onDragLeave() {
      this.dragOver = false;
    },

    async onDrop(event) {
      this.dragOver = false;
      const list = event && event.dataTransfer ? event.dataTransfer.files : null;
      await this.uploadFiles(list);
    },

    async onFilePick(event) {
      const input = event && event.target;
      await this.uploadFiles(input ? input.files : null);
      if (input) input.value = "";
    },

    // Upload each accepted file through the runtime's /files/upload endpoint —
    // the same path Benny's ingestion expects — then refresh statuses. Files
    // land in data_in as MISSING (staged, not yet ingested) until the operator
    // runs Ingest. Unsupported types are rejected client-side with a clear note.
    async uploadFiles(fileList) {
      const all = fileList ? Array.from(fileList) : [];
      if (!all.length) return;
      const accepted = all.filter((f) =>
        UPLOAD_EXTENSIONS.some((ext) =>
          String(f.name || "")
            .toLowerCase()
            .endsWith(ext)
        )
      );
      const rejected = all.length - accepted.length;
      if (!accepted.length) {
        this.ingestNote = `No supported files. Allowed types: ${UPLOAD_EXTENSIONS.join(", ")}.`;
        return;
      }
      this.uploading = true;
      this.ingestNote = `Uploading ${accepted.length} file${accepted.length === 1 ? "" : "s"}…`;
      let ok = 0;
      const errors = [];
      for (const file of accepted) {
        try {
          const form = new FormData();
          form.append("file", file, file.name);
          // No explicit Content-Type — the browser sets the multipart boundary.
          await readRuntimeJson(
            await runtimeFetch(
              `/files/upload?workspace=${encodeURIComponent(this.workspace)}&subdir=staging`,
              {
                method: "POST",
                body: form
              }
            )
          );
          ok += 1;
        } catch (err) {
          errors.push(`${file.name}: ${err && err.message ? err.message : String(err)}`);
        }
      }
      this.uploading = false;
      const parts = [];
      if (ok) parts.push(`Uploaded ${ok} file${ok === 1 ? "" : "s"}.`);
      if (rejected) parts.push(`Skipped ${rejected} unsupported file${rejected === 1 ? "" : "s"}.`);
      if (errors.length) parts.push(`Errors — ${errors.join("; ")}`);
      if (ok) parts.push('Run "Ingest → triples" to add them to the knowledge graph.');
      this.ingestNote = parts.join(" ");
      await this.loadFiles();
    },

    /* ── rescan the workspace on disk ── */

    async rescanWorkspace() {
      this.rescanning = true;
      this.ingestNote = "Rescanning the workspace for files…";
      try {
        const body = await readRuntimeJson(
          await runtimeFetch(
            `/files/recursive-scan?workspace=${encodeURIComponent(this.workspace)}`
          )
        );
        const total =
          body && Number.isFinite(body.total)
            ? body.total
            : body && Array.isArray(body.files)
              ? body.files.length
              : 0;
        await this.loadFiles();
        this.ingestNote = `Workspace rescanned — ${total} file${total === 1 ? "" : "s"} on disk, ${this.pendingCount} awaiting ingestion.`;
      } catch (err) {
        this.ingestNote = `Rescan failed: ${err && err.message ? err.message : String(err)}`;
      } finally {
        this.rescanning = false;
      }
    },

    async ingest() {
      // Only ingest the files the operator picked. Names map 1:1 to the
      // backend's data_in filenames (IngestRequest.files); an empty list would
      // make the backend glob EVERYTHING, so guard against it explicitly.
      const targets = this.files
        .filter((f) => this.selectedFiles.includes(f.name))
        .map((f) => f.name);
      if (!targets.length) {
        this.ingestNote = "Select at least one document to ingest (tick its checkbox).";
        return;
      }
      this.ingesting = true;
      this.visionSummary = "";
      try {
        // Optional Vision pass (VIS-001 / ADR-003): a local vision model reads each
        // figure/diagram into Mermaid diagram-as-code and tables into JSON, stitching
        // an enriched document into data_in BEFORE the standard ingest picks it up
        // (the enriched .md is newer than its source, so the converter skips it and
        // the enrichment survives). It's slower and needs the local vision model, so
        // a failure degrades gracefully to standard ingest rather than blocking.
        if (this.visionIngest) {
          this.ingestNote = `Vision pass: reading figures & tables in ${targets.length} document${targets.length === 1 ? "" : "s"} with the local vision model (slower)…`;
          try {
            // Aggregate the cascade outcome so the operator can SEE that figures became
            // diagrams (and how faithfully) — the whole point of the vision pass.
            let diagrams = 0,
              charts = 0,
              tables = 0,
              regions = 0;
            let judged = 0,
              captionFallbacks = 0;
            const vScores = [];
            for (const name of targets) {
              const q = `workspace=${encodeURIComponent(this.workspace)}&source=${encodeURIComponent(name)}`;
              await runtimeFetch(`/vision/docmodel?${q}`, { method: "POST" });
              // visual_judge + render_check default on: each produced diagram is scored
              // for fidelity against the original figure (best-wins, advisory gate).
              const eb = await readRuntimeJson(
                await runtimeFetch(`/vision/enrich?${q}&render_check=true`, { method: "POST" })
              );
              for (const doc of (eb && eb.enriched) || []) {
                const s = doc.summary || {};
                diagrams += s.diagrams || 0;
                charts += s.charts || 0;
                tables += s.tables || 0;
                regions += s.region_crops || 0;
                judged += s.visual_judged || 0;
                captionFallbacks += s.caption_fallback || 0;
                if (s.avg_visual_score != null && s.visual_judged)
                  vScores.push([s.avg_visual_score, s.visual_judged]);
              }
            }
            // Weighted mean of per-doc averages → one fidelity number.
            const totJudged = vScores.reduce((a, [, n]) => a + n, 0);
            const avgFidelity = totJudged
              ? (vScores.reduce((a, [v, n]) => a + v * n, 0) / totJudged).toFixed(1)
              : null;
            this.visionSummary =
              `Vision pass: ${diagrams} diagram${diagrams === 1 ? "" : "s"}` +
              (regions ? ` (${regions} from vector figures)` : "") +
              `, ${charts} chart${charts === 1 ? "" : "s"}, ${tables} table${tables === 1 ? "" : "s"}` +
              (avgFidelity != null
                ? ` · avg fidelity ${avgFidelity}/10 over ${judged} judged`
                : "") +
              (captionFallbacks ? ` · ${captionFallbacks} fell back to captions` : "");
          } catch (verr) {
            this.visionSummary = "";
            this.ingestNote = `Vision pass failed (${verr && verr.message ? verr.message : verr}) — is the local vision model running? Continuing with standard ingest…`;
          }
        }
        this.ingestNote = `Ingesting ${targets.length} document${targets.length === 1 ? "" : "s"} into the knowledge graph…`;
        // deep_synthesis:true extracts semantic triples into Neo4j — without it
        // the Documents knowledge graph (which reads Neo4j) stays empty even on
        // a "successful" vector ingest. The chip promises triples, so build them.
        const body = await readRuntimeJson(
          await runtimeFetch("/rag/ingest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspace: this.workspace,
              deep_synthesis: true,
              files: targets
            })
          })
        );
        const status = body && body.status;
        if (status === "failed") {
          // The runtime now reports honest failures (e.g. embedding provider
          // down) instead of a hollow success — surface the message verbatim.
          this.ingestNote = `Ingest failed: ${body.message || "no documents were indexed."}`;
        } else {
          const runId = body && (body.run_id || body.task_id || body.id);
          const indexed = body && Number.isFinite(body.indexed_files) ? body.indexed_files : null;
          const failed = body && Number.isFinite(body.failed_files) ? body.failed_files : 0;
          const parts = [];
          if (indexed !== null) parts.push(`Indexed ${indexed} file${indexed === 1 ? "" : "s"}`);
          if (failed) parts.push(`${failed} failed`);
          parts.push(runId ? `(run ${runId})` : "");
          if (this.visionSummary) parts.push(this.visionSummary);
          parts.push("Triples will populate the graph as files are processed.");
          this.ingestNote = parts.filter(Boolean).join(" · ");
        }
        // Refresh the triples view and per-file statuses shortly after kick-off.
        setTimeout(() => this.mountKnowledgeGraph(), 1500);
        setTimeout(() => this.loadFiles(), 2500);
      } catch (err) {
        this.ingestNote = `Ingest failed: ${err && err.message ? err.message : String(err)}`;
      } finally {
        this.ingesting = false;
      }
    },

    async runWizardWorkflow() {
      if (!this.wizardWorkflow || this.wizardCliRunning) return;
      this.wizardCliRunning = true;
      this.wizardCliVisible = true;
      this.wizardCliStatus = "Starting...";
      this.wizardCliOutput = "";

      try {
        const res = await fetch("/api/workflows_run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace: this.workspace,
            workflowCommand: this.wizardWorkflow
          })
        });

        if (!res.ok) {
          throw new Error(`Server returned ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");

          // keep the last chunk if it's incomplete
          buffer = events.pop() || "";

          for (const ev of events) {
            const lines = ev.split("\n");
            let eventName = "";
            let dataStr = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) eventName = line.substring(7).trim();
              if (line.startsWith("data: ")) dataStr = line.substring(6).trim();
            }
            if (eventName && dataStr) {
              try {
                const data = JSON.parse(dataStr);
                if (eventName === "status") this.wizardCliStatus = data;
                if (eventName === "stdout") this.wizardCliOutput += data;
                if (eventName === "stderr") this.wizardCliOutput += data;
                if (eventName === "close") this.wizardCliStatus = `Finished (code ${data.code})`;
                if (eventName === "error") this.wizardCliStatus = `Error: ${data.message}`;

                // scroll to bottom
                const pre = this.$refs.cliOutput;
                if (pre) pre.scrollTop = pre.scrollHeight;
              } catch (e) {}
            }
          }
        }
      } catch (err) {
        this.wizardCliStatus = `Failed: ${err.message}`;
      } finally {
        this.wizardCliRunning = false;
      }
    },

    async correlate() {
      this.ingestNote = "Building CORRELATES_WITH edges between documents and code…";
      try {
        await readRuntimeJson(
          await runtimeFetch("/rag/correlate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspace: this.workspace })
          })
        );
        this.ingestNote =
          "Correlation overlay built — switch to Code 3D to see the linked concepts.";
        this.mountKnowledgeGraph();
      } catch (err) {
        this.ingestNote = `Correlate failed: ${err && err.message ? err.message : String(err)}`;
      }
    },

    // Ask a question against the ingested documents. With agentMode on, the
    // backend routes through the adaptive pipeline: the agent decides whether
    // to retrieve (no_retrieval / single_step / multi_hop), grades the chunks,
    // and self-corrects with a query rewrite if it comes up empty — so it can
    // actually see and validate the source docs. agentMode off = the lighter
    // always-retrieve "semantic" path (fewer local LLM calls).
    async askDocs() {
      const q = (this.docQuestion || "").trim();
      if (!q) return;
      this.asking = true;
      this.docAnswer = "";
      this.docSources = [];
      this.docRoute = "";
      this.docTrace = [];
      try {
        const mode = this.agentMode ? "adaptive" : "semantic";
        const body = await readRuntimeJson(
          await runtimeFetch("/rag/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: q, workspace: this.workspace, mode })
          })
        );
        this.docAnswer = (body && body.answer) || "No answer returned.";
        this.docSources = body && Array.isArray(body.sources) ? body.sources : [];
        this.docRoute = (body && body.route) || "";
        this.docTrace = body && Array.isArray(body.execution_trace) ? body.execution_trace : [];
      } catch (err) {
        this.docAnswer = `Query failed: ${err && err.message ? err.message : String(err)}`;
      } finally {
        this.asking = false;
      }
    },

    /* ── Code 3D ── */

    async mountCode() {
      const host = this.$refs.codeGraph;
      if (!host) return;
      this._codeWidget = this.track(
        createCodeGraphCanvasWidget(
          host,
          {
            workspace: this.workspace,
            selectedNodeId: this.selection ? this.selection.id : "",
            visibleTypes: [...this.codeVisibleTypes],
            onSelect: (id) => this.onNodeSelect(id)
          },
          {
            renderer: this.code3d
              ? makeAnimeOrbRenderer({ onSelect: (id) => this.onNodeSelect(id) })
              : this.makeForceRenderer(this.codePhysics)
          }
        )
      );
    },

    toggleCode3d() {
      this.code3d = !this.code3d;
      this.destroyWidgets();
      this.mountCode();
    },

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

    // The default cockpit renderer: the living, organic 2D force graph (the
    // Memo-Ray look). Offline — its library is vendored, no CDN. The 3D
    // (three_renderer) scene is the opt-in alternative behind the *3d toggles.
    makeForceRenderer(physicsMode = "fluid") {
      return createForceGraph2DRenderer({
        physicsMode,
        onNodeClick: (id) => this.onNodeSelect(id)
      });
    },

    /* ── Flows (plan -> run) ── */

    async mountFlows() {
      // Load the workflow library (templates + your saved); the planner stage
      // stays empty until you plan a new manifest or open a saved workflow.
      await this.loadWorkflows();
    },

    /* ── Flows — workflow library (list / view / clone / edit / save / delete) ── */

    // GET /api/workflows/workflows → { workflows: [{id,name,description,type,
    // readonly,nodes,edges}], metadata }. Merges examples (templates) + your saved.
    async loadWorkflows() {
      this.workflowsLoading = true;
      try {
        const body = await readRuntimeJson(await runtimeFetch("/workflows/workflows"));
        this.workflows = body && Array.isArray(body.workflows) ? body.workflows : [];
      } catch (err) {
        this.workflows = [];
        this.workflowNote = `Couldn't load workflows: ${err && err.message ? err.message : String(err)}`;
      } finally {
        this.workflowsLoading = false;
      }
    },

    workflowEditable() {
      const w = this.selectedWorkflow;
      return !!w && !w.readonly && w.type !== "example";
    },

    teardownDesigner() {
      if (_designerWidget) {
        _designerWidget.destroy();
        _designerWidget = null;
      }
      this.designerOn = false;
      this.designerNode = null;
    },

    async openWorkflow(id) {
      this.workflowNote = "";
      this.workflowEditing = false;
      this.teardownDesigner();
      try {
        const wf = await readRuntimeJson(
          await runtimeFetch(`/workflows/workflows/${encodeURIComponent(id)}`)
        );
        this.selectedWorkflowId = id;
        this.selectedWorkflow = wf;
        this.workflowDraft = JSON.stringify(wf, null, 2);
        await this.$nextTick();
        this.renderWorkflowDag(wf);
      } catch (err) {
        this.workflowNote = `Open failed: ${err && err.message ? err.message : String(err)}`;
      }
    },

    renderWorkflowDag(wf) {
      const host = this.$refs.flowsDag;
      if (!host) return;
      this.destroyWidgets();
      this.track(createDagCanvasWidget(host, { mode: "workflow", data: workflowToDag(wf) }));
    },

    // Mount the interactive visual designer over the selected workflow. For
    // templates it mounts read-only (view); for your own it's fully editable.
    // onChange keeps workflowDraft in sync so Save / raw-JSON reflect the canvas.
    designWorkflow() {
      this.workflowEditing = false;
      this.designerOn = true;
      this.designerNode = null;
      this.$nextTick(() => {
        const hostEl = this.$refs.wfDesigner;
        if (!hostEl) return;
        if (_designerWidget) {
          _designerWidget.destroy();
          _designerWidget = null;
        }
        _designerWidget = createWorkflowDesignerWidget(hostEl, {
          workflow: this.selectedWorkflow || { nodes: [], edges: [] },
          readonly: !this.workflowEditable(),
          onChange: (graph) => {
            const m = this.selectedWorkflow || {};
            this.workflowDraft = JSON.stringify(
              {
                id: m.id,
                name: m.name,
                description: m.description || "",
                nodes: graph.nodes,
                edges: graph.edges
              },
              null,
              2
            );
          },
          onSelect: (node) => {
            this.designerNode = node
              ? { id: node.id, label: node.data.label, type: node.type }
              : null;
          }
        });
      });
    },

    // Push the node config form's label/type back into the canvas live.
    applyDesignerNode() {
      if (_designerWidget && this.designerNode) {
        _designerWidget.patchNode(this.designerNode.id, {
          label: this.designerNode.label,
          type: this.designerNode.type
        });
      }
    },

    // Blank editable workflow (saved only when you hit Save).
    newWorkflow() {
      const id = "wf_" + Date.now().toString(36);
      const def = { id, name: "New workflow", description: "", nodes: [], edges: [] };
      this.selectedWorkflowId = id;
      this.selectedWorkflow = def;
      this.workflowDraft = JSON.stringify(def, null, 2);
      this.workflowNote = "New workflow — add nodes, wire them up, then Save.";
      this.destroyWidgets();
      this.designWorkflow();
    },

    // Copy a template (or any workflow) into a new editable id under your saved set.
    cloneWorkflow() {
      const src = this.selectedWorkflow;
      if (!src) return;
      const base = String(src.id || "workflow").replace(/[^a-zA-Z0-9_-]/g, "_");
      const id = `${base}_copy_${Date.now().toString(36)}`;
      const def = { ...src, id, name: `Copy of ${src.name || src.id}` };
      delete def.readonly;
      delete def.type;
      delete def.file_path;
      this.selectedWorkflowId = id;
      this.selectedWorkflow = def;
      this.workflowDraft = JSON.stringify(def, null, 2);
      this.workflowNote = "Cloned to an editable copy — design it, then Save.";
      this.designWorkflow();
    },

    // POST /api/workflows/workflows. Validates the edited JSON before sending.
    async saveWorkflow() {
      let def;
      if (this.designerOn && _designerWidget) {
        // Build the definition from the live canvas + the editable meta fields.
        const m = this.selectedWorkflow || {};
        const g = _designerWidget.getGraph();
        def = {
          id: m.id,
          name: m.name,
          description: m.description || "",
          nodes: g.nodes,
          edges: g.edges
        };
      } else {
        try {
          def = JSON.parse(this.workflowDraft);
        } catch (e) {
          this.workflowNote = `Invalid JSON: ${e.message}`;
          return;
        }
      }
      if (!def.id) {
        this.workflowNote = 'Workflow needs an "id".';
        return;
      }
      if (!def.name) {
        this.workflowNote = 'Workflow needs a "name".';
        return;
      }
      this.workflowSaving = true;
      try {
        await readRuntimeJson(
          await runtimeFetch("/workflows/workflows", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(def)
          })
        );
        this.workflowNote = `Saved "${def.name}".`;
        this.workflowEditing = false;
        await this.loadWorkflows();
        await this.openWorkflow(def.id);
      } catch (err) {
        this.workflowNote = `Save failed: ${err && err.message ? err.message : String(err)}`;
      } finally {
        this.workflowSaving = false;
      }
    },

    async deleteWorkflow(id) {
      try {
        await readRuntimeJson(
          await runtimeFetch(`/workflows/workflows/${encodeURIComponent(id)}`, { method: "DELETE" })
        );
        if (this.selectedWorkflowId === id) {
          this.selectedWorkflow = null;
          this.selectedWorkflowId = "";
          this.workflowDraft = "";
          this.destroyWidgets();
        }
        this.workflowNote = "Deleted.";
        await this.loadWorkflows();
      } catch (err) {
        this.workflowNote = `Delete failed: ${err && err.message ? err.message : String(err)}`;
      }
    },

    async planFlow() {
      const requirement = this.requirement.trim();
      if (!requirement) {
        this.flowNote = "Type what you want the pipeline to do first.";
        return;
      }
      this.planning = true;
      this.flowNote = "Planning…";
      try {
        const manifest = await readRuntimeJson(
          await runtimeFetch("/manifests/plan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requirement,
              workspace: this.workspace,
              strategy: this.strategy
            })
          })
        );
        this.flowManifestId = manifest && manifest.id ? manifest.id : "";
        this.flowNote = this.flowManifestId
          ? `Planned manifest ${this.flowManifestId}. Review the DAG, then Run.`
          : "Planned, but no manifest id returned.";
        await this.$nextTick();
        const host = this.$refs.flowsDag;
        if (host) {
          this.destroyWidgets();
          this.track(
            createDagCanvasWidget(host, { mode: "manifest", data: mapManifestToDagData(manifest) })
          );
        }
        this.syncContext();
      } catch (err) {
        this.flowNote = `Plan failed: ${err && err.message ? err.message : String(err)}`;
      } finally {
        this.planning = false;
      }
    },

    async runFlow() {
      if (!this.flowManifestId) {
        this.flowNote = "Plan a manifest first.";
        return;
      }
      this.running = true;
      this.flowNote = "Running…";
      try {
        const res = await readRuntimeJson(
          await runtimeFetch(`/manifests/${encodeURIComponent(this.flowManifestId)}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspace: this.workspace })
          })
        );
        const runId = res && (res.run_id || res.id);
        if (runId) {
          this.activeRunId = runId;
          this.syncContext();
          if (this.splitActive && this.mode !== "runs") {
            // Keep the flow on screen; surface the new run in the Observe pane.
            this.flowNote = `Run ${runId} started — tracking in Observe →`;
            await this.loadRuns();
            this.observeRun(runId);
          } else {
            this.flowNote = `Run ${runId} started — opening observability.`;
            await this.setMode("runs");
          }
        } else {
          this.flowNote = "Run started, but no run id returned.";
        }
      } catch (err) {
        this.flowNote = `Run failed: ${err && err.message ? err.message : String(err)}`;
      } finally {
        this.running = false;
      }
    },

    /* ── Flows — deep produce (decompose → fan-out → synthesize → review) ── */

    async deepProduce() {
      const goal = (this.dpGoal || "").trim();
      if (!goal) {
        this.dpNote = "Type a goal to produce first.";
        return;
      }
      this.stopDeepProducePoll();
      this.dpView = null;
      this.dpStatus = "running";
      this.dpNote = "Planning panels and fanning out model calls…";
      try {
        const body = await readRuntimeJson(
          await runtimeFetch("/deep-produce", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ goal, workspace: this.workspace, panels: this.dpPanels })
          })
        );
        this.dpRunId = body && body.run_id ? body.run_id : "";
        if (!this.dpRunId) {
          this.dpStatus = "failed";
          this.dpNote = "No run id returned.";
          return;
        }
        this.dpNote = `Run ${this.dpRunId} started — fanning out ${this.dpPanels} panels. Open the fan-out trace to watch each call.`;
        this.pollDeepProduce();
      } catch (err) {
        this.dpStatus = "failed";
        this.dpNote = `Deep produce failed to start: ${err && err.message ? err.message : String(err)}`;
      }
    },

    async pollDeepProduce() {
      if (!this.dpRunId) return;
      try {
        const res = await readRuntimeJson(
          await runtimeFetch(
            `/deep-produce/${encodeURIComponent(this.dpRunId)}?workspace=${encodeURIComponent(this.workspace)}`
          )
        );
        const status = res && res.status ? res.status : "";
        if (status === "completed" && res.view) {
          this.dpView = res.view;
          this.dpStatus = "completed";
          this.dpNote = `Produced "${res.view.title}" — ${res.view.panels.length} panels. The fan-out trace is in Runs.`;
          this.stopDeepProducePoll();
          return;
        }
        if (status === "failed") {
          this.dpStatus = "failed";
          this.dpNote = `Deep produce failed: ${res && res.error ? res.error : "unknown error"}`;
          this.stopDeepProducePoll();
          return;
        }
        // pending / planning / running → keep polling.
        this._dpPollTimer = setTimeout(() => this.pollDeepProduce(), 2500);
      } catch {
        // Transient (e.g. run record not flushed yet) — retry.
        this._dpPollTimer = setTimeout(() => this.pollDeepProduce(), 3000);
      }
    },

    stopDeepProducePoll() {
      if (this._dpPollTimer) {
        clearTimeout(this._dpPollTimer);
        this._dpPollTimer = null;
      }
    },

    openDeepProduceTrace() {
      if (!this.dpRunId) return;
      this.activeRunId = this.dpRunId;
      if (this.splitActive && this.mode !== "runs") this.observeRun(this.dpRunId);
      else this.setMode("runs");
    },

    /* ── Studio (notebook) ────────────────────────────────────────────────
       A cell-based surface that unifies the two capabilities that were
       stranded in separate modes: a chat cell (single response, /rag/chat —
       same path as Documents "Ask the docs") and a report cell (multi-step
       fan-out, /deep-produce — same path as Flows "Deep produce"). Cells
       stack like a notebook and keep their own output + trace link. */

    mountStudio() {
      if (!this.studioCells.length) this.addStudioCell("chat");
    },

    addStudioCell(kind) {
      this._studioSeq += 1;
      this.studioCells.push({
        id: `cell-${this._studioSeq}`,
        kind: kind === "report" ? "report" : "chat",
        prompt: "",
        panels: 4,
        status: "idle", // idle | running | done | error
        note: "",
        answer: "",
        sources: [],
        route: "",
        trace: [],
        view: null,
        runId: "",
        _timer: null
      });
    },

    removeStudioCell(id) {
      const c = this.studioCells.find((x) => x.id === id);
      if (c && c._timer) {
        clearTimeout(c._timer);
        c._timer = null;
      }
      this.studioCells = this.studioCells.filter((x) => x.id !== id);
    },

    stopStudioPolls() {
      for (const c of this.studioCells) {
        if (c._timer) {
          clearTimeout(c._timer);
          c._timer = null;
        }
      }
    },

    async runStudioCell(id) {
      const cell = this.studioCells.find((x) => x.id === id);
      if (!cell) return;
      const prompt = (cell.prompt || "").trim();
      if (!prompt) {
        cell.note = "Type a prompt first.";
        return;
      }
      cell.status = "running";
      cell.note = "";
      if (cell.kind === "chat") {
        cell.answer = "";
        cell.sources = [];
        cell.route = "";
        cell.trace = [];
        try {
          const mode = this.agentMode ? "adaptive" : "semantic";
          const body = await readRuntimeJson(
            await runtimeFetch("/rag/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ query: prompt, workspace: this.workspace, mode })
            })
          );
          cell.answer = (body && body.answer) || "No answer returned.";
          cell.sources = body && Array.isArray(body.sources) ? body.sources : [];
          cell.route = (body && body.route) || "";
          cell.trace = body && Array.isArray(body.execution_trace) ? body.execution_trace : [];
          cell.status = "done";
        } catch (err) {
          cell.status = "error";
          cell.note = `Query failed: ${err && err.message ? err.message : String(err)}`;
        }
        return;
      }
      // report cell → deep produce
      cell.view = null;
      cell.runId = "";
      try {
        const body = await readRuntimeJson(
          await runtimeFetch("/deep-produce", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              goal: prompt,
              workspace: this.workspace,
              panels: cell.panels || 4
            })
          })
        );
        cell.runId = body && body.run_id ? body.run_id : "";
        if (!cell.runId) {
          cell.status = "error";
          cell.note = "No run id returned.";
          return;
        }
        cell.note = `Run ${cell.runId} — producing ${cell.panels || 4} panels…`;
        this.pollStudioCell(id);
      } catch (err) {
        cell.status = "error";
        cell.note = `Produce failed: ${err && err.message ? err.message : String(err)}`;
      }
    },

    async pollStudioCell(id) {
      const cell = this.studioCells.find((x) => x.id === id);
      if (!cell || !cell.runId) return;
      try {
        const res = await readRuntimeJson(
          await runtimeFetch(
            `/deep-produce/${encodeURIComponent(cell.runId)}?workspace=${encodeURIComponent(this.workspace)}`
          )
        );
        const status = res && res.status ? res.status : "";
        if (status === "completed" && res.view) {
          cell.view = res.view;
          cell.status = "done";
          cell.note = `Produced "${res.view.title}" — ${res.view.panels.length} panels.`;
          return;
        }
        if (status === "failed") {
          cell.status = "error";
          cell.note = `Produce failed: ${res && res.error ? res.error : "unknown error"}`;
          return;
        }
        cell._timer = setTimeout(() => this.pollStudioCell(id), 2500);
      } catch {
        cell._timer = setTimeout(() => this.pollStudioCell(id), 3000);
      }
    },

    // Jump a report cell's run into the observability surface (Observe pane in
    // split view, else the Runs mode).
    openStudioCellTrace(id) {
      const cell = this.studioCells.find((x) => x.id === id);
      if (!cell || !cell.runId) return;
      this.activeRunId = cell.runId;
      if (this.splitActive) this.observeRun(cell.runId);
      else this.setMode("runs");
    },

    /* ── Runs (observability) ── */

    async mountRuns() {
      await this.loadRuns();
      if (!this.activeRunId && this.runs.length) {
        this.activeRunId = this.runs[0].run_id || this.runs[0].id || "";
      }
      if (this.activeRunId) {
        await this.loadRunDetail(this.activeRunId);
        this.mountRunWidgets(this.activeRunId);
      }
      this.startRunPoll();
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

    // Full RunRecord for the active run — node_states (steps), errors, timing.
    async loadRunDetail(runId) {
      if (!runId) {
        this.runDetail = null;
        return;
      }
      try {
        this.runDetail = await readRuntimeJson(
          await runtimeFetch(`/manifests/runs/${encodeURIComponent(runId)}`)
        );
      } catch {
        this.runDetail = null;
      }
    },

    async selectRun(runId) {
      this.activeRunId = runId;
      this.activeStepId = "";
      this.onNodeSelect(runId, `run ${runId}`);
      await this.loadRunDetail(runId);
      this.mountRunWidgets(runId);
      this.startRunPoll();
    },

    mountRunWidgets(runId) {
      this.destroyWidgets();
      const timeline = this.$refs.runsTimeline;
      const trace = this.$refs.runsTrace;
      if (timeline) {
        this._runTimeline = this.track(
          createLineageTimelineWidget(timeline, { workspace: this.workspace, run_id: runId })
        );
      }
      if (trace) {
        this._runTrace = this.track(
          createReasoningTraceWidget(trace, { workspace: this.workspace, run_id: runId })
        );
      }

      this.mountDrilldown();
    },

    // Drill into a step: rows + CLP binding via /pypes/runs/{run}/steps/{step}.
    // The widget renders an honest "no checkpoint" message for non-pypes steps.
    async selectStep(stepId) {
      this.activeStepId = this.activeStepId === stepId ? "" : stepId;
      await this.$nextTick();
      this.mountDrilldown();
    },

    mountDrilldown() {
      if (this._drillWidget) {
        try {
          this._drillWidget.destroy();
        } catch {
          /* swallow */
        }
        this._drillWidget = null;
      }
      const host = this.$refs.runsDrilldown;
      if (host && this.activeStepId && this.activeRunId) {
        this._drillWidget = createDrilldownTableWidget(host, {
          run_id: this.activeRunId,
          step_id: this.activeStepId,
          workspace: this.workspace,
          rows: 100
        });
      }
    },

    /* ── live monitoring — refresh while a run is in-flight ── */

    toggleLive() {
      this.livePoll = !this.livePoll;
      if (this.livePoll) this.startRunPoll();
      else this.stopRunPoll();
    },

    stopRunPoll() {
      if (this._livePollTimer) {
        clearTimeout(this._livePollTimer);
        this._livePollTimer = null;
      }
    },

    startRunPoll() {
      this.stopRunPoll();
      if (!this.livePoll) return;
      const tick = async () => {
        if (!this.livePoll) {
          this._livePollTimer = null;
          return;
        }
        // Only do work when an observability surface is actually on screen.
        const visible = this.mode === "runs" || this.splitActive;
        const rec =
          this.runDetail || this.runs.find((r) => (r.run_id || r.id) === this.activeRunId);
        const inflight = this.activeRunId && rec && !isTerminalStatus(rec.status);
        if (visible && inflight) {
          await this.loadRuns();
          await this.loadRunDetail(this.activeRunId);
          if (this._runTimeline) this._runTimeline.refresh();
          if (this._runTrace) this._runTrace.refresh();
          if (this._obsTimeline) this._obsTimeline.refresh();
          if (this._obsTrace) this._obsTrace.refresh();
          if (this._drillWidget) this._drillWidget.refresh();
        }
        this._livePollTimer = setTimeout(tick, 3000);
      };
      this._livePollTimer = setTimeout(tick, 3000);
    },

    /* ── Agents (model + provider routing — one config surface) ── */

    async mountAgents() {
      await this.loadAgents();
    },

    async loadAgents() {
      this.agentNote = "";
      try {
        const [status, config] = await Promise.all([
          readRuntimeJson(await runtimeFetch("/llm/status")),
          readRuntimeJson(
            await runtimeFetch(`/llm/config?workspace=${encodeURIComponent(this.workspace)}`)
          )
        ]);
        this.agentProviders = status && typeof status === "object" ? status : {};
        this.agentConfig = config || null;
        this.agentRoles = config && Array.isArray(config.roles) ? config.roles : [];
        this.agentModelOptions = this.buildModelOptions(this.agentProviders);
      } catch (err) {
        this.agentNote = `Couldn't load agent config: ${err && err.message ? err.message : String(err)}`;
      }
    },

    // Flatten running providers into provider/model_id options that match what
    // get_active_model() returns and call_model() expects.
    buildModelOptions(providers) {
      const opts = [];
      for (const [key, p] of Object.entries(providers || {})) {
        const models = p && p.models && Array.isArray(p.models.data) ? p.models.data : [];
        for (const m of models) {
          if (!m || !m.id) continue;
          opts.push({
            value: `${key}/${m.id}`,
            label: m.id,
            provider: (p && p.name) || key,
            running: !!(p && p.running)
          });
        }
      }
      return opts;
    },

    agentProviderList() {
      return Object.entries(this.agentProviders || {}).map(([key, p]) => ({
        key,
        name: (p && p.name) || key,
        running: !!(p && p.running),
        port: p && p.port,
        models: p && p.models && Array.isArray(p.models.data) ? p.models.data.length : 0,
        canStart: !!(p && p.can_start),
        canStop: !!(p && p.can_stop),
        error: (p && p.error) || ""
      }));
    },

    roleValue(role) {
      const roles =
        this.agentConfig && this.agentConfig.model_roles ? this.agentConfig.model_roles : {};
      return roles[role] || "";
    },

    setRoleValue(role, value) {
      if (!this.agentConfig) return;
      if (!this.agentConfig.model_roles) this.agentConfig.model_roles = {};
      this.agentConfig.model_roles[role] = value;
    },

    resolvedFor(role) {
      const r = this.agentConfig && this.agentConfig.resolved ? this.agentConfig.resolved : {};
      return r[role] || "";
    },

    // Per-model reasoning toggle. thinkingOff(value)=true → the model runs with
    // hidden chain-of-thought suppressed (/no_think + enable_thinking:false).
    thinkingOff(modelValue) {
      const m =
        this.agentConfig && this.agentConfig.model_thinking ? this.agentConfig.model_thinking : {};
      return m[modelValue] === "off";
    },

    toggleThinking(modelValue) {
      if (!this.agentConfig) return;
      if (!this.agentConfig.model_thinking) this.agentConfig.model_thinking = {};
      if (this.agentConfig.model_thinking[modelValue] === "off") {
        delete this.agentConfig.model_thinking[modelValue]; // back to model default (think on)
      } else {
        this.agentConfig.model_thinking[modelValue] = "off"; // suppress thinking
      }
    },

    async saveAgents() {
      if (!this.agentConfig) return;
      this.agentSaving = true;
      this.agentNote = "Saving model routing…";
      try {
        const updated = await readRuntimeJson(
          await runtimeFetch("/llm/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspace: this.workspace,
              default_model: this.agentConfig.default_model || "",
              model_roles: this.agentConfig.model_roles || {},
              model_thinking: this.agentConfig.model_thinking || {}
            })
          })
        );
        this.agentConfig = updated || this.agentConfig;
        this.agentNote = "Saved. New routing takes effect on the next run — no restart needed.";
      } catch (err) {
        this.agentNote = `Save failed: ${err && err.message ? err.message : String(err)}`;
      } finally {
        this.agentSaving = false;
      }
    },

    async toggleProvider(key, running) {
      const action = running ? "stop" : "start";
      this.agentNote = `${running ? "Stopping" : "Starting"} ${key}…`;
      try {
        await readRuntimeJson(
          await runtimeFetch(`/llm/${encodeURIComponent(key)}/${action}`, { method: "POST" })
        );
        this.agentNote = `${key}: ${action} requested.`;
        setTimeout(() => this.loadAgents(), 1500);
      } catch (err) {
        this.agentNote = `${key} ${action} failed: ${err && err.message ? err.message : String(err)}`;
      }
    },

    /* ── workspace + conformance (shared) ── */

    async loadWorkspaces(attempt = 0) {
      try {
        // The proxy maps runtimeFetch("/workspaces") → runtime /api/workspaces,
        // which returns the workspace names. Tolerate both string-array and
        // object-array ({id,...}) shapes across runtime versions.
        const list = await readRuntimeJson(await runtimeFetch("/workspaces"));
        const names = Array.isArray(list)
          ? list
              .map((x) => (typeof x === "string" ? x : x && x.id))
              .filter((x) => typeof x === "string" && x)
          : [];
        if (names.length) {
          this.workspaces = names;
          if (!this.workspaces.includes(this.workspace)) this.workspace = this.workspaces[0];
          return;
        }
        throw new Error("empty workspace list");
      } catch {
        // On a cold desktop launch the runtime may still be booting — retry a
        // few times before giving up so the list isn't stuck on ["default"].
        if (attempt < 5) {
          setTimeout(() => this.loadWorkspaces(attempt + 1), 1500);
        }
      }
    },

    onWorkspaceChange() {
      this.syncContext();
      // Re-mount the workspace-scoped surfaces.
      if (this.mode === "documents") this.mountDocuments();
      else if (this.mode === "code") {
        this.destroyWidgets();
        this.mountCode();
      } else if (this.mode === "agents") this.loadAgents();
    },

    async loadConformance() {
      try {
        const res = await fetch("/api/integration_audit", { credentials: "same-origin" });
        if (!res.ok) {
          this.conformance = { status: "unknown", driftCount: 0 };
          return;
        }
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
        this.flowNote =
          "Benny isn't available on this page yet — open the agent dock and try again.";
      }
    },

    /* ── zen ── */

    toggleZen() {
      this.zen = !this.zen;
    },

    retry() {
      this.init();
    },

    destroy() {
      if (this._activityUnsub) {
        this._activityUnsub();
        this._activityUnsub = null;
      }
      this.stopDeepProducePoll();
      this.stopRunPoll();
      this.stopStudioPolls();
      if (this._onResize && typeof window !== "undefined") {
        window.removeEventListener("resize", this._onResize);
      }
      this.destroySecondary();
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
  UPLOAD_EXTENSIONS,
  readQuery,
  isValidMode,
  lifelogIconFor,
  relativeTime,
  summariseRuns,
  fileStatusLabel,
  fileStatusClass,
  mergeFileStatus
};
