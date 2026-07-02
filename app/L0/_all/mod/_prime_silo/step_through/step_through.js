// Phase 2b (deep mode) — Step-Through Audit Player (#/_prime_silo/step_through).
//
// Native port of memo-ray BetaDashboard.jsx's "calming step-through audit": walk a
// session's actions one at a time with a plain-English caption (hero text), the
// preceding intent ("Why?"), the raw content or a diff for edits, a downsampled
// milestone scrubber, and a lineage map that highlights + tracks the current step.
// Playback (play/pause + speed), keyboard (←/→), gamepad (bumpers / D-pad), and an
// optional speech narrator drive navigation.
//
// Decoupled architecture (MEMORAY-MERGE.md Phase 2): thin Alpine view over the
// shared memoray-client data layer + the reusable memoray.lineage_graph widget
// (the map; current node highlighted by toggling a class on its [data-node-id]).
// Earth-tone memo-ray theme via `mray-theme`. Read-only: GET /beta/timeline,
// /graph/:id, /entities/:id, /sessions. Deep-linkable:
// #/_prime_silo/step_through?session_id=<id>.

import {
  memorayFetch,
  readMemorayJson,
  isMemorayOffline,
  isMemorayDisabled
} from "../memoray_client/memoray-client.js";
import { createLineageGraphWidget } from "../widgets/memoray/lineage_graph/index.js";

// Read-only tools collapse into a single "researched/read" group to cut noise —
// mirrors memo-ray's grouping.
const READ_TOOLS = [
  "grep_search",
  "list_dir",
  "view_file",
  "search_web",
  "read_url_content",
  "read_file"
];
const MAX_BAR_SEGMENTS = 600;
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Collapse consecutive read-only tool calls into one group entry.
function groupTimeline(rawActions) {
  const grouped = [];
  let current = null;
  for (const action of rawActions) {
    const isReadOnly = action.type === "Tool Call" && READ_TOOLS.includes(action.toolName);
    if (isReadOnly) {
      if (!current) {
        current = {
          isGroup: true,
          type: "Tool Group",
          agent: action.agent,
          timestamp: action.timestamp,
          items: [action],
          id: `group-${action.id}`
        };
        grouped.push(current);
      } else {
        current.items.push(action);
        current.timestamp = action.timestamp;
      }
    } else {
      current = null;
      grouped.push(action);
    }
  }
  return grouped;
}

function heroText(action) {
  if (!action) return "";
  const agent = action.agent === "Claude" ? "Claude" : "Antigravity";
  if (action.isGroup) {
    return `${agent} spent ${action.items.length} steps researching and reading files.`;
  }
  if (action.type === "Tool Call") {
    if (
      action.toolName === "replace_file_content" ||
      action.toolName === "write_to_file" ||
      action.toolName === "multi_replace_file_content"
    ) {
      return `${agent} edited ${action.fileName || "a file"}.`;
    }
    if (action.toolName === "run_command") return `${agent} ran a terminal command.`;
    return `${agent} used the ${action.toolName} tool.`;
  }
  if (action.type === "User Input") return `You provided new instructions to ${agent}.`;
  if (action.type === "Thought" || action.type === "PLANNER_RESPONSE")
    return `${agent} stopped to think and plan the next move.`;
  if (action.type === "Tool Result") return `${agent} received the results of the tool execution.`;
  if (action.type === "Artifact")
    return `${agent} created an artifact: ${action.fileName || "Untitled"}.`;
  return `${agent} performed an action (${action.type}).`;
}

function isMilestone(action) {
  if (!action || action.isGroup) return false;
  if (action.type === "User Input" || action.type === "Artifact") return true;
  if (action.type === "Tool Call" && action.toolName === "run_command") {
    const snippet = action.contentSnippet || "";
    if (snippet.includes("git commit") || snippet.includes("npm run build")) return true;
  }
  return false;
}

// Render an edit's content as a simple +/- diff when it's a structured replace,
// else escaped raw text. Returns an HTML string.
function renderDiffHtml(contentStr) {
  const raw = String(contentStr || "");
  try {
    const parsed = JSON.parse(raw);
    const chunkHtml = (target, replacement) =>
      `<div class="prime-silo-st__diff-chunk">` +
      String(target || "")
        .split("\n")
        .map((l) => `<div class="prime-silo-st__diff-line removed">- ${escapeHtml(l)}</div>`)
        .join("") +
      String(replacement || "")
        .split("\n")
        .map((l) => `<div class="prime-silo-st__diff-line added">+ ${escapeHtml(l)}</div>`)
        .join("") +
      `</div>`;
    if (parsed.TargetContent && parsed.ReplacementContent) {
      return `<div class="prime-silo-st__diff">${chunkHtml(parsed.TargetContent, parsed.ReplacementContent)}</div>`;
    }
    if (Array.isArray(parsed.ReplacementChunks)) {
      return `<div class="prime-silo-st__diff">${parsed.ReplacementChunks.map((c) => chunkHtml(c.TargetContent, c.ReplacementContent)).join("")}</div>`;
    }
    return `<pre>${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`;
  } catch {
    return `<pre>${escapeHtml(raw)}</pre>`;
  }
}

window.stepThroughPage = function stepThroughPage() {
  return {
    state: "loading", // loading | picking | ready | offline | disabled | error
    error: "",
    sessions: [],
    sessionId: "",
    timeline: [],
    stepIndex: 0,
    fullContent: "",
    showWhy: false,
    whyText: "",
    isPlaying: false,
    speed: 2,
    narrator: false,
    showMap: true,
    tracking: true,
    graphMode: "auto", // auto | linear | force — auto picks force for big sessions
    _graph: null,
    _playTimer: null,
    _raf: 0,
    _gamepadState: {},
    _keyHandler: null,

    async init() {
      const requested = readSessionIdFromQuery();
      if (requested) {
        this.sessionId = requested;
        await this.loadSession();
      } else {
        await this.loadPicker();
      }
      this._keyHandler = (e) => this.onKey(e);
      window.addEventListener("keydown", this._keyHandler);
      this._raf = requestAnimationFrame(() => this.pollGamepads());
    },

    async loadPicker() {
      this.state = "loading";
      try {
        const list = await readMemorayJson(await memorayFetch("/sessions"));
        this.sessions = Array.isArray(list) ? list : [];
        this.state = "picking";
      } catch (err) {
        this.applyErrorState(err);
      }
    },

    pickSession(id) {
      this.sessionId = id;
      this.loadSession();
    },

    async loadSession() {
      this.state = "loading";
      this.isPlaying = false;
      try {
        const [timelineData, graphData] = await Promise.all([
          readMemorayJson(
            await memorayFetch(
              `/beta/timeline?session=${encodeURIComponent(this.sessionId)}&limit=100000`
            )
          ),
          readMemorayJson(
            await memorayFetch(`/graph/${encodeURIComponent(this.sessionId)}?limit=100000`)
          ).catch(() => ({ nodes: [], links: [] }))
        ]);
        const actions = (Array.isArray(timelineData) ? timelineData : [])
          .filter((a) => a.sessionId === this.sessionId)
          .reverse();
        this.timeline = groupTimeline(actions);
        this.stepIndex = 0;
        this.state = "ready";
        this._graphData = graphData && graphData.nodes ? graphData : { nodes: [], links: [] };
        this.$nextTick(() => {
          this.mountGraph();
          this.onStepChanged();
        });
      } catch (err) {
        this.applyErrorState(err);
      }
    },

    applyErrorState(err) {
      if (isMemorayDisabled(err)) this.state = "disabled";
      else if (isMemorayOffline(err)) this.state = "offline";
      else {
        this.state = "error";
        this.error = err && err.message ? err.message : String(err);
      }
    },

    mountGraph() {
      const host = this.$refs.graph;
      if (!host || !this.showMap) return;
      if (this._graph) this._graph.destroy();
      this._graph = createLineageGraphWidget(host, {
        data: this._graphData,
        onSelect: (nodeId) => this.jumpToNode(nodeId),
        layoutMode: this.graphMode,
        forceThreshold: 60,
        highlightIds: this.currentNodeIds,
        track: this.tracking
      });
    },

    get current() {
      return this.timeline[this.stepIndex] || null;
    },

    get currentNodeIds() {
      const a = this.current;
      if (!a) return [];
      return a.isGroup ? a.items.map((i) => i.id) : [a.id];
    },

    get heroText() {
      return heroText(this.current);
    },

    get milestoneSegments() {
      const n = this.timeline.length;
      if (n === 0) return [];
      if (n <= MAX_BAR_SEGMENTS) {
        return this.timeline.map((act, idx) => ({
          idx,
          end: idx,
          milestone: isMilestone(act)
        }));
      }
      const segs = [];
      for (let b = 0; b < MAX_BAR_SEGMENTS; b++) {
        const start = Math.floor((b * n) / MAX_BAR_SEGMENTS);
        const end = Math.floor(((b + 1) * n) / MAX_BAR_SEGMENTS);
        let milestone = false;
        for (let i = start; i < end; i++) {
          if (isMilestone(this.timeline[i])) {
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
      return {
        "is-milestone": seg.milestone,
        past,
        active
      };
    },

    formatTime(ts) {
      const n = Number(ts) || 0;
      return n ? new Date(n).toLocaleTimeString() : "";
    },

    contentHtml() {
      const a = this.current;
      if (!a) return "";
      if (a.isGroup) {
        const tools = Array.from(new Set(a.items.map((i) => i.toolName))).join(", ");
        return `<div class="prime-silo-st__group"><p>Grouped ${a.items.length} read operations to reduce noise.</p><p class="prime-silo-st__muted">Includes: ${escapeHtml(tools)}</p></div>`;
      }
      if (a.toolName === "replace_file_content" || a.toolName === "multi_replace_file_content") {
        return renderDiffHtml(this.fullContent || "");
      }
      return `<pre>${escapeHtml(this.fullContent || a.contentSnippet || "(loading content…)")}</pre>`;
    },

    // Step transition: load full content + why, drive the map highlight/tracking,
    // and (optionally) narrate.
    async onStepChanged() {
      const a = this.current;
      this.showWhy = false;
      this.fullContent = "";
      if (!a) return;

      // Why = the nearest preceding Thought from the same agent.
      let why = "No specific thought log found immediately preceding this action.";
      for (let i = this.stepIndex - 1; i >= 0; i--) {
        const past = this.timeline[i];
        if (
          !past.isGroup &&
          (past.type === "Thought" || past.type === "PLANNER_RESPONSE") &&
          past.agent === a.agent
        ) {
          why = `${(past.contentSnippet || "").split(/[.?\n]/)[0]}.`;
          break;
        }
      }
      this.whyText = why;

      if (!a.isGroup) {
        try {
          const entity = await readMemorayJson(
            await memorayFetch(`/entities/${encodeURIComponent(a.id)}`)
          );
          if (this.current === a) this.fullContent = (entity && entity.content) || "";
        } catch {
          this.fullContent = "";
        }
      }

      this.highlightCurrent();
      if (this.narrator) this.speak(this.heroText);
    },

    // Drive the highlight + camera through the widget so it works in BOTH the
    // layered SVG (marks the node, scrolls it into view) and the free-floating
    // force graph (glows the node + pans the camera).
    highlightCurrent() {
      if (this._graph) {
        this._graph.update({ highlightIds: this.currentNodeIds, track: this.tracking });
      }
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

    toggleTracking() {
      this.tracking = !this.tracking;
      this.highlightCurrent();
    },

    setStep(idx) {
      const clamped = Math.max(0, Math.min(idx, this.timeline.length - 1));
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
            if (this.stepIndex >= this.timeline.length - 1) {
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
        // restart the interval at the new cadence
        this.isPlaying = false;
        this.togglePlay();
      }
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

    toggleNarrator() {
      this.narrator = !this.narrator;
      if (!this.narrator) this.cancelSpeech();
    },

    jumpToNode(nodeId) {
      const idx = this.timeline.findIndex(
        (step) =>
          step.id === nodeId ||
          step.nodeId === nodeId ||
          (step.items && step.items.some((n) => n.id === nodeId))
      );
      if (idx >= 0) this.setStep(idx);
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

    pollGamepads() {
      if (this.state === "ready" && typeof navigator !== "undefined" && navigator.getGamepads) {
        const pads = navigator.getGamepads() || [];
        for (const gp of pads) {
          if (!gp) continue;
          const nextTrig = gp.buttons[5]?.pressed || gp.buttons[15]?.pressed;
          const prevTrig = gp.buttons[4]?.pressed || gp.buttons[14]?.pressed;
          const key = `gp-${gp.index}`;
          const prevState = this._gamepadState[key] || {};
          if (nextTrig && !prevState.next) this.setStep(this.stepIndex + 1);
          if (prevTrig && !prevState.prev) this.setStep(this.stepIndex - 1);
          this._gamepadState[key] = { next: nextTrig, prev: prevTrig };
        }
      }
      this._raf = requestAnimationFrame(() => this.pollGamepads());
    },

    speak(text) {
      try {
        if (typeof window === "undefined" || !window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        const msg = new SpeechSynthesisUtterance(text);
        const voices = window.speechSynthesis.getVoices();
        const soft = voices.find(
          (v) => v.name.includes("Samantha") || v.name.includes("Google US English")
        );
        if (soft) msg.voice = soft;
        msg.rate = 0.9;
        window.speechSynthesis.speak(msg);
      } catch {
        /* speech is best-effort */
      }
    },

    cancelSpeech() {
      try {
        if (typeof window !== "undefined" && window.speechSynthesis)
          window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    },

    retry() {
      this.init();
    },

    destroy() {
      if (this._playTimer) clearInterval(this._playTimer);
      this._playTimer = null;
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
      if (this._keyHandler) window.removeEventListener("keydown", this._keyHandler);
      this._keyHandler = null;
      this.cancelSpeech();
      if (this._graph) this._graph.destroy();
      this._graph = null;
    }
  };
};

function readSessionIdFromQuery() {
  try {
    const hash = typeof window !== "undefined" && window.location ? window.location.hash : "";
    const queryIndex = hash.indexOf("?");
    if (queryIndex < 0) return "";
    return new URLSearchParams(hash.slice(queryIndex + 1)).get("session_id") || "";
  } catch {
    return "";
  }
}

export const __testing = {
  groupTimeline,
  heroText,
  isMilestone,
  renderDiffHtml,
  READ_TOOLS,
  MAX_BAR_SEGMENTS
};
