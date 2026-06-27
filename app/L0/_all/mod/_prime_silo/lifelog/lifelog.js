// Phase 2 — Agent Lifelog page (#/_prime_silo/lifelog).
//
// Native port of memo-ray's AgentLifelog.jsx: a unified timeline of git commits
// and agent actions across all workspaces, with an Activity Radar (heatmap) that
// filters the feed by day. Part of the decoupled memo-ray screen architecture
// (MEMORAY-MERGE.md Phase 2) — a thin Alpine view over the shared memoray-client
// data layer and the memoray.heatmap_radar widget; no memo-ray React anywhere.
//
// Read-only (GET /lifelog every 10s; the radar GETs /heatmap-stats). Disabled
// and offline are first-class screens, never a stack trace. Teleportable rows
// (sessions, or artifacts that carry a sessionId) deep-link into the Memory page
// at #/_prime_silo/memory?session_id=<id>, which selects that session's lineage.

import {
  memorayFetch,
  readMemorayJson,
  isMemorayOffline,
  isMemorayDisabled
} from "../memoray_client/memoray-client.js";
import { createHeatmapRadarWidget } from "../widgets/memoray/heatmap_radar/index.js";

const POLL_MS = 10000;

window.lifelogPage = function lifelogPage() {
  return {
    state: "loading", // loading | ready | offline | disabled | error
    error: "",
    items: [],
    selectedDate: null,
    _heatmap: null,
    _timer: null,

    async init() {
      await this.loadLifelog();
      if (this.state !== "ready") return;
      this.$nextTick(() => this.mountHeatmap());
      this._timer = setInterval(() => this.pollLifelog(), POLL_MS);
    },

    async loadLifelog() {
      this.state = "loading";
      try {
        const list = await readMemorayJson(await memorayFetch("/lifelog"));
        this.items = Array.isArray(list) ? list : [];
        this.state = "ready";
      } catch (err) {
        this.applyErrorState(err);
      }
    },

    async pollLifelog() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const list = await readMemorayJson(await memorayFetch("/lifelog"));
        if (Array.isArray(list)) this.items = list;
      } catch {
        // Best-effort refresh; a hard outage surfaces on the next manual retry.
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

    mountHeatmap() {
      const host = this.$refs.heatmap;
      if (!host) return;
      this._heatmap = createHeatmapRadarWidget(host, {
        selectedDate: this.selectedDate,
        onDateSelect: (date) => {
          this.selectedDate = date;
          if (this._heatmap) this._heatmap.update({ selectedDate: date });
        }
      });
    },

    get filteredItems() {
      if (!this.selectedDate) return this.items;
      return this.items.filter((item) => this.localDateOf(item.timestamp) === this.selectedDate);
    },

    // Match memo-ray's local-date convention so a radar cell and a feed row
    // agree on which calendar day an event belongs to.
    localDateOf(timestamp) {
      const ts = Number(timestamp) || 0;
      const local = new Date(ts - new Date().getTimezoneOffset() * 60000);
      return local.toISOString().split("T")[0];
    },

    isTeleportable(item) {
      return item.type === "session" || (item.type === "artifact" && Boolean(item.sessionId));
    },

    avatarKind(item) {
      if (item.type === "commit") return "commit";
      if (item.type === "artifact") return "artifact";
      if (item.agent === "Claude") return "claude";
      if (item.agent === "Antigravity") return "antigravity";
      return "other";
    },

    primaryName(item) {
      return item.type === "commit" ? item.author : item.agent;
    },

    formatTime(timestamp) {
      const ts = Number(timestamp) || 0;
      return ts ? new Date(ts).toLocaleString() : "";
    },

    teleport(item) {
      if (!this.isTeleportable(item)) return;
      const sessionId = item.type === "session" ? item.id : item.sessionId;
      if (!sessionId) return;
      window.location.hash = `#/_prime_silo/memory?session_id=${encodeURIComponent(sessionId)}`;
    },

    retry() {
      this.init();
    },

    destroy() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
      if (this._heatmap && typeof this._heatmap.destroy === "function") this._heatmap.destroy();
      this._heatmap = null;
    }
  };
};

export const __testing = { POLL_MS };
