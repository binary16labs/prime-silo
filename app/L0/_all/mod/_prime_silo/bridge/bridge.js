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
import { createWorkflowDesignerWidget } from "../widgets/workflow_designer/index.js";
import { createLineageTimelineWidget } from "../widgets/run/lineage_timeline/index.js";
import { createReasoningTraceWidget } from "../widgets/run/reasoning_trace/index.js";
import { createThreeRenderer } from "../widgets/three_renderer/index.js";
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
  { id: "runs", label: "Runs", icon: "timeline" },
  { id: "agents", label: "Agents", icon: "smart_toy" }
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
  ],
  agents: [
    { label: "Which model runs synthesis?", instruction: "Tell me which model is currently resolved for graph_synthesis in this workspace and whether it's local." },
    { label: "Recommend a local setup", instruction: "Recommend which local models to assign to chat and graph_synthesis given my running providers." }
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
    case "ALIGNED": return "Ingested";
    case "MISSING": return "Not ingested";
    case "STAGED": return "Staged";
    default: return status || "Unknown";
  }
}

export function fileStatusClass(status) {
  switch (status) {
    case "ALIGNED": return "is-ingested";
    case "MISSING": return "is-pending";
    default: return "is-staged";
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
      kind: n.type || "node",
    })),
    edges: (Array.isArray(w.edges) ? w.edges : []).map((e) => ({
      source: e.source,
      target: e.target,
      label: e.label,
    })),
  };
}

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
    selectedFiles: [],   // names of files the operator picked to ingest
    ingesting: false,
    ingestNote: "",
    dragOver: false,
    uploading: false,
    rescanning: false,
    // documents — ask (RAG chat over the ingested docs)
    docQuestion: "",
    docAnswer: "",
    docSources: [],
    docRoute: "",
    docTrace: [],
    agentMode: true,
    asking: false,
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

    // flows — workflow library (manage/view/update templates + saved)
    workflows: [],
    workflowsLoading: false,
    selectedWorkflowId: "",
    selectedWorkflow: null,
    workflowDraft: "",       // JSON of the selected workflow being edited
    workflowEditing: false,  // toggles the raw JSON editor
    designerOn: false,       // toggles the visual node designer
    designerNode: null,      // { id, label, type } of the selected node (config form)
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

    // runs
    runs: [],
    activeRunId: "",

    // agents (model + provider routing — single config surface)
    agentProviders: {},     // raw /llm/status
    agentConfig: null,      // /llm/config (default_model, model_roles, resolved)
    agentModelOptions: [],  // [{ value:"lmstudio/<id>", label, provider, running }]
    agentRoles: [],
    agentSaving: false,
    agentNote: "",

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
        case "agents": return this.mountAgents();
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

    // List the workspace's staged files and reconcile them against the
    // knowledge-graph indexing manifest so each row carries its ingestion
    // status (Ingested / Not ingested / Staged) and chunk count.
    async loadFiles() {
      try {
        const [filesBody, manifest] = await Promise.all([
          readRuntimeJson(await runtimeFetch(`/files?workspace=${encodeURIComponent(this.workspace)}`)),
          this.loadIndexingManifest()
        ]);
        const dataIn = filesBody && Array.isArray(filesBody.data_in) ? filesBody.data_in : [];
        this.files = mergeFileStatus(dataIn, manifest);
        this.reconcileSelection();
      } catch {
        this.files = [];
        this.selectedFiles = [];
      }
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

    isSelected(name) { return this.selectedFiles.includes(name); },

    toggleFile(name) {
      const i = this.selectedFiles.indexOf(name);
      if (i === -1) this.selectedFiles.push(name);
      else this.selectedFiles.splice(i, 1);
    },

    selectAllFiles() { this.selectedFiles = this.files.map((f) => f.name); },
    clearFileSelection() { this.selectedFiles = []; },

    async loadIndexingManifest() {
      try {
        const body = await readRuntimeJson(
          await runtimeFetch(`/rag/indexing-manifest?workspace=${encodeURIComponent(this.workspace)}`)
        );
        return body && Array.isArray(body.manifest) ? body.manifest : [];
      } catch {
        return [];
      }
    },

    statusLabel(status) { return fileStatusLabel(status); },
    statusClass(status) { return fileStatusClass(status); },

    get pendingCount() {
      return this.files.filter((f) => f.status !== "ALIGNED").length;
    },

    /* ── drag-drop + upload (correct Benny ingestion path) ── */

    onDragOver() { this.dragOver = true; },
    onDragLeave() { this.dragOver = false; },

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
        UPLOAD_EXTENSIONS.some((ext) => String(f.name || "").toLowerCase().endsWith(ext))
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
          await readRuntimeJson(await runtimeFetch(
            `/files/upload?workspace=${encodeURIComponent(this.workspace)}`,
            { method: "POST", body: form }
          ));
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
          await runtimeFetch(`/files/recursive-scan?workspace=${encodeURIComponent(this.workspace)}`)
        );
        const total = body && Number.isFinite(body.total)
          ? body.total
          : (body && Array.isArray(body.files) ? body.files.length : 0);
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
      this.ingestNote = `Ingesting ${targets.length} document${targets.length === 1 ? "" : "s"} into the knowledge graph…`;
      try {
        // deep_synthesis:true extracts semantic triples into Neo4j — without it
        // the Documents knowledge graph (which reads Neo4j) stays empty even on
        // a "successful" vector ingest. The chip promises triples, so build them.
        const body = await readRuntimeJson(await runtimeFetch("/rag/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace: this.workspace, deep_synthesis: true, files: targets })
        }));
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
        const body = await readRuntimeJson(await runtimeFetch("/rag/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q, workspace: this.workspace, mode })
        }));
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
      if (_designerWidget) { _designerWidget.destroy(); _designerWidget = null; }
      this.designerOn = false;
      this.designerNode = null;
    },

    async openWorkflow(id) {
      this.workflowNote = "";
      this.workflowEditing = false;
      this.teardownDesigner();
      try {
        const wf = await readRuntimeJson(await runtimeFetch(`/workflows/workflows/${encodeURIComponent(id)}`));
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
        if (_designerWidget) { _designerWidget.destroy(); _designerWidget = null; }
        _designerWidget = createWorkflowDesignerWidget(hostEl, {
          workflow: this.selectedWorkflow || { nodes: [], edges: [] },
          readonly: !this.workflowEditable(),
          onChange: (graph) => {
            const m = this.selectedWorkflow || {};
            this.workflowDraft = JSON.stringify(
              { id: m.id, name: m.name, description: m.description || "", nodes: graph.nodes, edges: graph.edges },
              null, 2
            );
          },
          onSelect: (node) => {
            this.designerNode = node ? { id: node.id, label: node.data.label, type: node.type } : null;
          },
        });
      });
    },

    // Push the node config form's label/type back into the canvas live.
    applyDesignerNode() {
      if (_designerWidget && this.designerNode) {
        _designerWidget.patchNode(this.designerNode.id, { label: this.designerNode.label, type: this.designerNode.type });
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
      delete def.readonly; delete def.type; delete def.file_path;
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
        def = { id: m.id, name: m.name, description: m.description || "", nodes: g.nodes, edges: g.edges };
      } else {
        try { def = JSON.parse(this.workflowDraft); }
        catch (e) { this.workflowNote = `Invalid JSON: ${e.message}`; return; }
      }
      if (!def.id) { this.workflowNote = 'Workflow needs an "id".'; return; }
      if (!def.name) { this.workflowNote = 'Workflow needs a "name".'; return; }
      this.workflowSaving = true;
      try {
        await readRuntimeJson(await runtimeFetch("/workflows/workflows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(def)
        }));
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
        await readRuntimeJson(await runtimeFetch(`/workflows/workflows/${encodeURIComponent(id)}`, { method: "DELETE" }));
        if (this.selectedWorkflowId === id) {
          this.selectedWorkflow = null; this.selectedWorkflowId = ""; this.workflowDraft = "";
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

    /* ── Flows — deep produce (decompose → fan-out → synthesize → review) ── */

    async deepProduce() {
      const goal = (this.dpGoal || "").trim();
      if (!goal) { this.dpNote = "Type a goal to produce first."; return; }
      this.stopDeepProducePoll();
      this.dpView = null;
      this.dpStatus = "running";
      this.dpNote = "Planning panels and fanning out model calls…";
      try {
        const body = await readRuntimeJson(await runtimeFetch("/deep-produce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal, workspace: this.workspace, panels: this.dpPanels })
        }));
        this.dpRunId = body && body.run_id ? body.run_id : "";
        if (!this.dpRunId) { this.dpStatus = "failed"; this.dpNote = "No run id returned."; return; }
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
        const res = await readRuntimeJson(await runtimeFetch(
          `/deep-produce/${encodeURIComponent(this.dpRunId)}?workspace=${encodeURIComponent(this.workspace)}`
        ));
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
      if (this._dpPollTimer) { clearTimeout(this._dpPollTimer); this._dpPollTimer = null; }
    },

    openDeepProduceTrace() {
      if (!this.dpRunId) return;
      this.activeRunId = this.dpRunId;
      this.setMode("runs");
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

    /* ── Agents (model + provider routing — one config surface) ── */

    async mountAgents() {
      await this.loadAgents();
    },

    async loadAgents() {
      this.agentNote = "";
      try {
        const [status, config] = await Promise.all([
          readRuntimeJson(await runtimeFetch("/llm/status")),
          readRuntimeJson(await runtimeFetch(`/llm/config?workspace=${encodeURIComponent(this.workspace)}`))
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
          opts.push({ value: `${key}/${m.id}`, label: m.id, provider: (p && p.name) || key, running: !!(p && p.running) });
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
      const roles = this.agentConfig && this.agentConfig.model_roles ? this.agentConfig.model_roles : {};
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
      const m = this.agentConfig && this.agentConfig.model_thinking ? this.agentConfig.model_thinking : {};
      return m[modelValue] === "off";
    },

    toggleThinking(modelValue) {
      if (!this.agentConfig) return;
      if (!this.agentConfig.model_thinking) this.agentConfig.model_thinking = {};
      if (this.agentConfig.model_thinking[modelValue] === "off") {
        delete this.agentConfig.model_thinking[modelValue];   // back to model default (think on)
      } else {
        this.agentConfig.model_thinking[modelValue] = "off";  // suppress thinking
      }
    },

    async saveAgents() {
      if (!this.agentConfig) return;
      this.agentSaving = true;
      this.agentNote = "Saving model routing…";
      try {
        const updated = await readRuntimeJson(await runtimeFetch("/llm/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace: this.workspace,
            default_model: this.agentConfig.default_model || "",
            model_roles: this.agentConfig.model_roles || {},
            model_thinking: this.agentConfig.model_thinking || {}
          })
        }));
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
        await readRuntimeJson(await runtimeFetch(`/llm/${encodeURIComponent(key)}/${action}`, { method: "POST" }));
        this.agentNote = `${key}: ${action} requested.`;
        setTimeout(() => this.loadAgents(), 1500);
      } catch (err) {
        this.agentNote = `${key} ${action} failed: ${err && err.message ? err.message : String(err)}`;
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
      else if (this.mode === "agents") this.loadAgents();
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
      this.stopDeepProducePoll();
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
