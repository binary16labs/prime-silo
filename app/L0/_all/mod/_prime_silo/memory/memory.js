// Phase M1 — memory page entry (#/_prime_silo/memory).
//
// Review-zone shell page for the Memo-Ray memory graph. Composes two native
// widgets (memoray.overview_cards Command Center + memoray.lineage_graph)
// over the /api/memoray proxy, with a session list, omnibar search, node
// inspector, sync, and a conformance strip fed by GET /api/integration_audit.
//
// Disabled (MEMORAY_ENABLED=false) and offline (server down) are first-class
// screens, not errors — the user never lands on a stack trace. Deep-linkable
// via #/_prime_silo/memory?session_id=<id> so the memory-recall agent skill
// and external links can jump straight to a session's lineage.

import {
  memorayFetch,
  readMemorayJson,
  isMemorayOffline,
  isMemorayDisabled
} from "../memoray_client/memoray-client.js";
import { createOverviewCardsWidget } from "../widgets/memoray/overview_cards/index.js";
import { createLineageGraphWidget } from "../widgets/memoray/lineage_graph/index.js";

window.memoryPage = function memoryPage() {
  return {
    state: "loading", // loading | ready | offline | disabled | error
    error: "",
    sessions: [],
    activeSessionId: "",
    agentFilter: "all",
    searchQuery: "",
    searchResults: null,
    inspector: null,
    syncing: false,
    conformance: { status: "", driftCount: 0 },
    zenLink: "http://localhost:5173",
    _cardsWidget: null,
    _graphWidget: null,

    async init() {
      await this.loadSessions();
      if (this.state !== "ready") {
        return;
      }
      this.$nextTick(() => {
        this.mountCards();
        const requested = readSessionIdFromQuery();
        if (requested && this.sessions.some((s) => s.id === requested)) {
          this.selectSession(requested);
        }
      });
      this.loadConformance();
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

    mountCards() {
      const host = this.$refs.cards;
      if (!host) return;
      this._cardsWidget = createOverviewCardsWidget(host, {
        onSelectSession: (id) => this.selectSession(id)
      });
    },

    selectSession(sessionId) {
      if (!sessionId) return;
      this.activeSessionId = sessionId;
      this.searchResults = null;
      this.inspector = null;
      this.$nextTick(() => this.mountGraph(sessionId));
    },

    mountGraph(sessionId) {
      const host = this.$refs.graph;
      if (!host) return;
      const props = {
        sessionId,
        onSelect: (nodeId) => this.inspectNode(nodeId)
      };
      if (this._graphWidget && typeof this._graphWidget.update === "function") {
        this._graphWidget.update(props);
      } else {
        this._graphWidget = createLineageGraphWidget(host, props);
      }
    },

    async inspectNode(nodeId) {
      try {
        this.inspector = await readMemorayJson(await memorayFetch(`/entities/${encodeURIComponent(nodeId)}`));
      } catch {
        this.inspector = null;
      }
    },

    async runSearch() {
      const q = this.searchQuery.trim();
      if (q.length < 2) {
        this.searchResults = null;
        return;
      }
      try {
        this.searchResults = await readMemorayJson(await memorayFetch(`/beta/search?q=${encodeURIComponent(q)}`));
      } catch {
        this.searchResults = null;
      }
    },

    async syncNow() {
      this.syncing = true;
      try {
        await readMemorayJson(await memorayFetch("/sync"));
        await this.loadSessions();
        if (this._cardsWidget) this._cardsWidget.refresh();
      } catch (err) {
        this.applyErrorState(err);
      } finally {
        this.syncing = false;
      }
    },

    async openFile(filePath) {
      if (!filePath) return;
      try {
        await readMemorayJson(await memorayFetch("/files/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath })
        }));
      } catch {
        // Open is best-effort; memo-ray 403s paths outside the lineage.
      }
    },

    async loadConformance() {
      try {
        const response = await fetch("/api/integration_audit", { credentials: "same-origin" });
        if (!response.ok) {
          this.conformance = { status: "unknown", driftCount: 0 };
          return;
        }
        const report = await response.json();
        const memoray = (report.integrations || []).find((r) => r.id === "memoray");
        if (!memoray) {
          this.conformance = { status: "unknown", driftCount: 0 };
          return;
        }
        this.conformance = {
          status: memoray.status,
          driftCount: memoray.summary ? memoray.summary.drift : 0
        };
      } catch {
        this.conformance = { status: "unknown", driftCount: 0 };
      }
    },

    retry() {
      this.init();
    },

    destroy() {
      if (this._cardsWidget && typeof this._cardsWidget.destroy === "function") this._cardsWidget.destroy();
      if (this._graphWidget && typeof this._graphWidget.destroy === "function") this._graphWidget.destroy();
      this._cardsWidget = null;
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
