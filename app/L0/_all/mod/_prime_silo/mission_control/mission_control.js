// Phase 2 — Mission Control page (#/_prime_silo/mission_control).
//
// Native port of the landing of memo-ray's BetaDashboard.jsx: the Command Center
// — live ecosystem rollup (sessions / tokens / worktrees), system resources +
// capabilities, the file-memory heatmap, the activity radar, recent agent
// activity, and an omnibar that searches sessions / files / actions. Auto-syncs
// every 10s with a live pulse, mirroring the React original.
//
// Decoupled architecture (MEMORAY-MERGE.md Phase 2): a thin Alpine view that
// composes the reusable memoray.overview_cards + memoray.heatmap_radar widgets
// over the shared memoray-client data layer; earth-tone memo-ray theme via
// `mray-theme`. Read-only. Drilling into a session deep-links to the Session
// Graph page (#/_prime_silo/session_graph?session_id=<id>).
//
// NOTE: the deeper step-through "audit player" from BetaDashboard (timeline
// playback, gamepad, speech narrator, camera-tracked organic graph) is tracked
// as follow-up work — see MEMORAY-MERGE.md Phase 2b.

import {
  memorayFetch,
  readMemorayJson,
  isMemorayOffline,
  isMemorayDisabled
} from "../memoray_client/memoray-client.js";
import { createOverviewCardsWidget } from "../widgets/memoray/overview_cards/index.js";
import { createHeatmapRadarWidget } from "../widgets/memoray/heatmap_radar/index.js";

const SYNC_MS = 10000;

window.missionControlPage = function missionControlPage() {
  return {
    state: "loading", // loading | ready | offline | disabled | error
    error: "",
    searchQuery: "",
    searchResults: null,
    liveSyncing: false,
    _cards: null,
    _radar: null,
    _timer: null,

    async init() {
      // Probe once so we can render disabled/offline as first-class screens
      // before mounting the heavier widgets.
      try {
        await readMemorayJson(await memorayFetch("/ecosystem/manifest"));
        this.state = "ready";
      } catch (err) {
        this.applyErrorState(err);
        return;
      }
      this.$nextTick(() => this.mountWidgets());
      this._timer = setInterval(() => this.liveSync(), SYNC_MS);
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

    mountWidgets() {
      const cardsHost = this.$refs.cards;
      const radarHost = this.$refs.radar;
      if (cardsHost) {
        this._cards = createOverviewCardsWidget(cardsHost, {
          onSelectSession: (id) => this.openSession(id)
        });
      }
      if (radarHost) {
        this._radar = createHeatmapRadarWidget(radarHost, {});
      }
    },

    async liveSync() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      this.liveSyncing = true;
      try {
        await readMemorayJson(await memorayFetch("/sync"));
        // Silent refresh: swap in fresh data without flashing the loading state.
        if (this._cards) this._cards.refresh(true);
        if (this._radar) this._radar.refresh(true);
      } catch {
        // Best-effort background sync; the widgets keep their last good render.
      } finally {
        setTimeout(() => {
          this.liveSyncing = false;
        }, 800);
      }
    },

    async runSearch() {
      const q = this.searchQuery.trim();
      if (q.length < 2) {
        this.searchResults = null;
        return;
      }
      try {
        this.searchResults = await readMemorayJson(
          await memorayFetch(`/beta/search?q=${encodeURIComponent(q)}`)
        );
      } catch {
        this.searchResults = null;
      }
    },

    openSession(sessionId) {
      if (!sessionId) return;
      window.location.hash = `#/_prime_silo/session_graph?session_id=${encodeURIComponent(sessionId)}`;
    },

    retry() {
      this.init();
    },

    destroy() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
      if (this._cards && typeof this._cards.destroy === "function") this._cards.destroy();
      if (this._radar && typeof this._radar.destroy === "function") this._radar.destroy();
      this._cards = null;
      this._radar = null;
    }
  };
};

export const __testing = { SYNC_MS };
