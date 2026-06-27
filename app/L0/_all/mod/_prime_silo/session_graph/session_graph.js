// Phase 2 — Session Graph page (#/_prime_silo/session_graph).
//
// Native port of memo-ray's "Session Graph" tab (UnifiedDashboard + OrganicGraph):
// a focused, full-canvas lineage explorer — pick a session, see its recursive
// lineage graph (with virtual file nodes), inspect any node. Distinct from the
// Memory page (which leads with the Command Center cards); this page is the graph
// itself, large.
//
// Decoupled architecture (MEMORAY-MERGE.md Phase 2): thin Alpine view over the
// shared memoray-client data layer + the reusable memoray.lineage_graph widget;
// earth-tone memo-ray theme via `mray-theme`. Read-only (GET /sessions, /graph,
// /entities). Deep-linkable: #/_prime_silo/session_graph?session_id=<id>.

import {
  memorayFetch,
  readMemorayJson,
  isMemorayOffline,
  isMemorayDisabled
} from "../memoray_client/memoray-client.js";
import { createLineageGraphWidget } from "../widgets/memoray/lineage_graph/index.js";

window.sessionGraphPage = function sessionGraphPage() {
  return {
    state: "loading", // loading | ready | offline | disabled | error
    error: "",
    sessions: [],
    activeSessionId: "",
    agentFilter: "all",
    inspector: null,
    _graphWidget: null,

    async init() {
      await this.loadSessions();
      if (this.state !== "ready") return;
      this.$nextTick(() => {
        const requested = readSessionIdFromQuery();
        const target =
          requested && this.sessions.some((s) => s.id === requested)
            ? requested
            : this.sessions[0] && this.sessions[0].id;
        if (target) this.selectSession(target);
      });
    },

    async loadSessions() {
      this.state = "loading";
      try {
        const list = await readMemorayJson(await memorayFetch("/sessions"));
        this.sessions = Array.isArray(list) ? list : [];
        this.state = "ready";
      } catch (err) {
        this.applyErrorState(err);
      }
    },

    applyErrorState(err) {
      if (isMemorayDisabled(err)) {
        this.state = "disabled";
      } else if (isMemorayOffline(err)) {
        this.state = "offline";
      } else {
        this.state = "error";
        this.error = err && err.message ? err.message : String(err);
      }
    },

    get filteredSessions() {
      if (this.agentFilter === "all") return this.sessions;
      const wanted = this.agentFilter.toLowerCase();
      return this.sessions.filter((s) => String(s.agent || "").toLowerCase() === wanted);
    },

    selectSession(sessionId) {
      if (!sessionId) return;
      this.activeSessionId = sessionId;
      this.inspector = null;
      this.$nextTick(() => this.mountGraph(sessionId));
    },

    mountGraph(sessionId) {
      const host = this.$refs.graph;
      if (!host) return;
      const props = { sessionId, onSelect: (nodeId) => this.inspectNode(nodeId) };
      if (this._graphWidget && typeof this._graphWidget.update === "function") {
        this._graphWidget.update(props);
      } else {
        this._graphWidget = createLineageGraphWidget(host, props);
      }
    },

    async inspectNode(nodeId) {
      try {
        this.inspector = await readMemorayJson(
          await memorayFetch(`/entities/${encodeURIComponent(nodeId)}`)
        );
      } catch {
        this.inspector = null;
      }
    },

    stepThrough() {
      if (!this.activeSessionId) return;
      window.location.hash = `#/_prime_silo/step_through?session_id=${encodeURIComponent(this.activeSessionId)}`;
    },

    async openFile(filePath) {
      if (!filePath) return;
      try {
        await readMemorayJson(
          await memorayFetch("/files/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filePath })
          })
        );
      } catch {
        // Best-effort; memo-ray 403s paths outside the lineage.
      }
    },

    retry() {
      this.init();
    },

    destroy() {
      if (this._graphWidget && typeof this._graphWidget.destroy === "function")
        this._graphWidget.destroy();
      this._graphWidget = null;
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

export const __testing = { readSessionIdFromQuery };
